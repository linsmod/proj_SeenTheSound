'use strict';

/* ============================================================
 * 运行时：资源层（BUF / WIN / ST / REG）+ 可重入执行器
 *
 * 分层：
 *   模块(Function)  = 纯函数 + 声明式元数据          → Ops.js / TopK.js
 *   绑定(bind)      = 模块 + 实例 → (fs)=>value      → Compile.js
 *   运行(runProgram)= 顺序执行一串 processor           ← 本文件
 *
 * 资源注册：BUF / WIN / ST
 * - key 必须静态（不能拼帧号/输入内容），但可以拼实例路径 fs.FN_KEY
 * - 同类 key 重复注册时 spec 必须一致，否则抛错
 * ============================================================ */

function ensureRegistries(fs) {
  if (!fs.BUFFERS) fs.BUFFERS = new Map();
  if (!fs.WINDOWS) fs.WINDOWS = new Map();
  if (!fs.STATES)  fs.STATES  = new Map();
  if (!fs.RES_LIMIT) fs.RES_LIMIT = { buffers: 4096, windows: 4096, states: 8192 };
  if (typeof fs.now !== 'function') fs.now = () => Date.now();
  if (!Number.isFinite(fs.DSP_FRAMES)) fs.DSP_FRAMES = 0;
  if (!Number.isFinite(fs.MAX_STEPS))  fs.MAX_STEPS = 1e6;
  // 一帧一份命名寄存器（接线用）；每帧开头由 DSPRun 清空
  if (!fs.REG) fs.REG = Object.create(null);
  // 可重入入口：高阶函数（mapEach / window / crossfade）靠它跑子链
  if (typeof fs.run !== 'function') fs.run = (program, input) => runProgram(program, input, fs);
  if (typeof fs.read !== 'function')  fs.read  = (name) => fs.REG[name];
  if (typeof fs.write !== 'function') fs.write = (name, v) => { fs.REG[name] = v; return v; };
  // 跳转助手：比手写 FN_JMP / FN_JNZ 清楚，语义见 takeJump()
  if (typeof fs.JUMP !== 'function') {
    fs.JUMP = (t) => { fs.FN_JMP = t; };
    fs.JUMP_IF = (cond, t) => { fs.FN_JNZ = cond; fs.FN_JMP = t; };
    fs.DJUMP = (t) => { fs.DSP_JMP = t; };
    fs.DJUMP_IF = (cond, t) => { fs.DSP_JNZ = cond; fs.DSP_JMP = t; };
  }
  fs.ERROR = null;
}

function now(fs) { return fs.now(); }

// --- BUFFER：固定容量环形，随机读，自淘汰，无需清理 ---
function BUF(fs, key, cap) {
  if (!Number.isInteger(cap) || cap <= 0)
    throw new Error(`BUF ${key}: cap must be positive integer`);
  let b = fs.BUFFERS.get(key);
  if (b) {
    if (b.cap !== cap) throw new Error(`BUF ${key}: cap mismatch ${b.cap} vs ${cap}`);
    return b;
  }
  if (fs.BUFFERS.size >= fs.RES_LIMIT.buffers)
    throw new Error(`BUF limit exceeded: ${key}`);
  b = { key, cap, samples: new Float32Array(cap), head: 0, count: 0 };
  fs.BUFFERS.set(key, b);
  return b;
}

function bPush(b, v) {
  b.samples[b.head] = v;
  b.head = (b.head + 1) % b.cap;
  if (b.count < b.cap) b.count++;
}

function bAt(b, i) { // i = 0 最新
  if (i < 0 || i >= b.count) return undefined;
  return b.samples[(((b.head - 1 - i) % b.cap) + b.cap) % b.cap];
}

// --- WINDOW：滑动窗口，只读聚合，按 domain 淘汰 ---
function WIN(fs, key, spec) {
  const cap       = spec.cap ?? 64;
  const domain    = spec.domain ?? 'frame';
  const stride    = spec.stride ?? 1;
  const windowMs  = spec.windowMs ?? 0;
  const ephemeral = !!spec.ephemeral;

  if (!Number.isInteger(cap) || cap <= 0) throw new Error(`WIN ${key}: cap`);
  if (domain !== 'frame' && domain !== 'time') throw new Error(`WIN ${key}: domain`);
  if (!Number.isInteger(stride) || stride <= 0) throw new Error(`WIN ${key}: stride`);

  let w = fs.WINDOWS.get(key);
  if (w) {
    const s = w.spec;
    if (s.cap !== cap || s.domain !== domain || s.stride !== stride ||
        s.windowMs !== windowMs || s.ephemeral !== ephemeral)
      throw new Error(`WIN ${key}: spec mismatch`);
    return w;
  }
  if (fs.WINDOWS.size >= fs.RES_LIMIT.windows)
    throw new Error(`WIN limit exceeded: ${key}`);

  w = {
    key,
    spec: { cap, domain, stride, windowMs, ephemeral },
    samples: new Float32Array(cap),
    ts: domain === 'time' ? new Float64Array(cap) : null,
    head: 0, count: 0, lastFrame: -1,
  };
  fs.WINDOWS.set(key, w);
  return w;
}

function wPush(w, fs, v) {
  if (!w.spec.ephemeral) {
    if (w.lastFrame === fs.DSP_FRAMES) return;             // 同帧只采一次
    if (w.spec.stride > 1 && (fs.DSP_FRAMES % w.spec.stride) !== 0) return;
    w.lastFrame = fs.DSP_FRAMES;
  }
  const cap = w.spec.cap;
  w.samples[w.head] = v;
  if (w.ts) w.ts[w.head] = now(fs);
  w.head = (w.head + 1) % cap;
  if (w.count < cap) w.count++;
}

function wAt(w, i) { // i = 0 最新
  if (i < 0 || i >= w.count) return undefined;
  const cap = w.spec.cap;
  return w.samples[(((w.head - 1 - i) % cap) + cap) % cap];
}

function wLatest(w) { return wAt(w, 0); }

function wSum(w) {
  let s = 0;
  for (let i = 0; i < w.count; i++) s += wAt(w, i);
  return s;
}

// 按"从最老到最新"的顺序读出去（画走势图用：左老右新）
function wRead(w, out) {
  const n = w.count;
  const a = out || new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = wAt(w, n - 1 - i);
  return a;
}

// --- STATE：跨帧标量/对象，不淘汰 ---
function ST(fs, key, init) {
  let s = fs.STATES.get(key);
  if (s) return s;
  if (fs.STATES.size >= fs.RES_LIMIT.states)
    throw new Error(`ST limit exceeded: ${key}`);
  s = { key, value: init };
  fs.STATES.set(key, s);
  return s;
}

/* ============================================================
 * 集中清理：只处理需要主动淘汰的窗口
 * - frame 域定长环形：自淘汰，不清理
 * - time 域：按 now() 淘汰过期样本
 * - ephemeral：帧末归零复用
 * ============================================================ */
function evictAll(fs) {
  const t = now(fs);
  for (const w of fs.WINDOWS.values()) {
    if (w.spec.ephemeral) {
      w.count = 0; w.head = 0; w.lastFrame = -1;
      continue;
    }
    if (w.spec.domain === 'time') {
      const cap = w.spec.cap;
      while (w.count > 0) {
        const oldest = (w.head - w.count + cap) % cap;
        if (t - w.ts[oldest] > w.spec.windowMs) w.count--;
        else break;
      }
    }
  }
}

/* ============================================================
 * 跳转：FN / DSP 两级共用一套语义
 *
 *   JUMP_IF(cond, target)  → 条件跳（cond 可为函数或值）
 *   JUMP(target)           → 无条件跳
 *   JNZ 单独给数字          → 等价于 JUMP(数字)（老写法，保留）
 *
 * 关键是顺序：**先判条件，再取目标**。
 * 老实现先看 FN_JMP 有没有值，导致"设了条件又设了目标"时条件被吞掉。
 * ============================================================ */
function takeJump(fs, pfx, len) {
  const cond = fs[pfx + '_JNZ'];
  const rawTarget = fs[pfx + '_JMP'];
  if (cond == null && rawTarget == null) return null;

  let target = rawTarget;

  if (cond != null) {
    let hit;
    if (typeof cond === 'function') hit = !!cond(fs);
    else if (typeof cond === 'number') hit = cond !== 0;
    else hit = !!cond;

    if (!hit) {                                   // 条件不成立：两个字段一起清掉，不留僵尸
      fs[pfx + '_JNZ'] = null;
      fs[pfx + '_JMP'] = null;
      return null;
    }
    if (target == null) {
      if (typeof cond === 'number') target = cond; // 老写法：JNZ=3 就是跳到 3
      else throw new Error(`${pfx}_JNZ 给了条件却没给跳转目标（${pfx}_JMP）`);
    }
  }

  fs[pfx + '_JNZ'] = null;
  fs[pfx + '_JMP'] = null;

  const t = Math.trunc(Number(target));
  if (!Number.isFinite(t) || t < 0 || t > len)
    throw new Error(`${pfx}_JMP 目标越界：${target}（合法 0..${len}）`);
  return t;
}

/* ============================================================
 * 执行器（可重入）
 *
 * program: [ { functions: (fs)=>[(fs)=>v, ...] } , ... ]
 * input  : 本帧入口值
 * 返回   : 本帧出口值
 *
 * 所有执行状态都是局部变量，只有 fs.FN_IDX 为了兼容 fn 内部改写而保留；
 * 进入时快照、退出时恢复，所以 fs.run(子程序) 可以任意嵌套。
 * ============================================================ */
function runProgram(program, input, fs) {
  ensureRegistries(fs);
  const arr = program || [];
  const save = { INPUT: fs.INPUT, FN_IDX: fs.FN_IDX, FUNCTIONS: fs.FUNCTIONS };

  let cur = input;
  let idx = 0;
  let steps = 0;

  try {
    while (idx < arr.length) {
      const proc = arr[idx];
      if (!proc) { idx++; continue; }

      const fns = (typeof proc.functions === 'function') ? proc.functions(fs) : (proc.functions || []);
      const list = fns || [];
      fs.FUNCTIONS = list;
      fs.FN_IDX = 0;
      fs.PROC_IDX = idx;

      while (fs.FN_IDX < list.length) {
        if (++steps > fs.MAX_STEPS)
          throw new Error(`runProgram step limit exceeded at frame ${fs.DSP_FRAMES}`);

        fs.INPUT = cur;                         // function 读的是"当前输入"
        cur = list[fs.FN_IDX](fs);
        fs.FN_IDX++;

        const t = takeJump(fs, 'FN', list.length);
        if (t !== null) fs.FN_IDX = t;
      }

      idx++;
      const dt = takeJump(fs, 'DSP', arr.length);
      if (dt !== null) idx = dt;
    }
  } finally {
    fs.INPUT = save.INPUT;                      // 嵌套调用不污染外层
    fs.FN_IDX = save.FN_IDX;
    fs.FUNCTIONS = save.FUNCTIONS;
  }

  return cur;
}

/* ============================================================
 * 每帧入口：包一层"帧边界"——时间戳、帧计数、清理、复位
 * ============================================================ */
function DSPRun(fs) {
  ensureRegistries(fs);

  fs.TS = now(fs);
  fs.REG = Object.create(null);                 // 一帧一份寄存器文件
  fs.ERROR = null;
  if (typeof fs.DSPPreFrame === 'function') fs.DSPPreFrame(fs);

  const out = runProgram(fs.DSP_ARR, fs.INPUT, fs);

  fs.OUTPUT = out;
  fs.DSP_FRAMES++;                              // 累积，不再每帧重置为 1

  evictAll(fs);

  // 帧末复位跳转/索引状态（资源实例保留）
  fs.DSP_IDX = 0;
  fs.FN_IDX = 0;
  fs.DSP_JMP = null;
  fs.FN_JMP = null;
  fs.DSP_JNZ = null;
  fs.FN_JNZ = null;

  if (typeof fs.DSPPostFrame === 'function') fs.DSPPostFrame(fs);
  return out;
}

/* ============================================================
 * 工厂
 * ============================================================ */
function createFrameState(opts = {}) {
  const fs = {
    INPUT: opts.INPUT,
    DSP_ARR: opts.DSP_ARR || [],
    REGS: opts.REGS || {},          // 用户自定义杂项状态，不参与资源生命周期
    DSP_IDX: 0, FN_IDX: 0, PROC_IDX: 0,
    DSP_JMP: null, FN_JMP: null,
    DSP_JNZ: null, FN_JNZ: null,
    DSP_FRAMES: 0,
    OUTPUT: undefined,
    TS: 0,
    now: opts.now || (() => Date.now()),
    MAX_STEPS: opts.MAX_STEPS ?? 1e6,
    DSPPreFrame: opts.DSPPreFrame,
    DSPPostFrame: opts.DSPPostFrame,
  };
  // 可重入 + 寄存器 + 跳转助手（ensureRegistries 里会补，这里先给上，便于外部直接用）
  fs.run = (program, input) => runProgram(program, input === undefined ? fs.INPUT : input, fs);
  fs.read = (name) => fs.REG[name];
  fs.write = (name, v) => { fs.REG[name] = v; return v; };
  fs.JUMP = (t) => { fs.FN_JMP = t; };
  fs.JUMP_IF = (cond, t) => { fs.FN_JNZ = cond; fs.FN_JMP = t; };
  fs.DJUMP = (t) => { fs.DSP_JMP = t; };
  fs.DJUMP_IF = (cond, t) => { fs.DSP_JNZ = cond; fs.DSP_JMP = t; };
  return fs;
}

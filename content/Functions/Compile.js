'use strict';

/* ============================================================
 * 编译层：把「模块 + 实例配置」编译成 DSPRun 认的 processor.functions
 *
 *   模块  mod  = 函数本体 + 元数据（id / kind / io / paramSchema / copyOutSchema）
 *   实例  inst = { on, args, switches, wired, tap, key }
 *   产物  bound = (fs) => value        ← 运行时唯一认的签名
 *
 * 这一层负责四件事：
 *   1) 适配：scalar / vector / plain / sink 四种写法统一成 (fs)=>value
 *   2) 注入：参数默认值、端口描述符与数据槽、实例命名空间 fs.FN_KEY
 *   3) 校验：进出形状（io）对不上就旁路并记 fs.ERROR，不炸整帧
 *   4) 抽头：bound.last / bound.hist 给"每级出图"用
 *
 * 载入顺序：Processor.js → Compile.js → 各模块（Ops.js / TopK.js …）
 * ============================================================ */

/* ---------- 注册表 ---------- */
var DSPFunctions = (typeof DSPFunctions !== 'undefined' && DSPFunctions) ? DSPFunctions : [];
var FUNCTION_MAP = (typeof FUNCTION_MAP !== 'undefined' && FUNCTION_MAP) ? FUNCTION_MAP : Object.create(null);

// 模块有两种写法，都收：
//   · 函数本体（plain 类，如 TopK）：function TopK(fs){…} 再挂属性
//   · 带 f() 的对象（scalar / vector 类，如 Ops.js）：{ kind:'scalar', f:(x,p)=>… }
function registerFunction(mod) {
  const isFn = typeof mod === 'function';
  if (!isFn && (!mod || typeof mod !== 'object' || typeof mod.f !== 'function'))
    throw new Error('registerFunction: 需要函数本体，或带 f() 的模块对象');
  const id = mod.id || mod.name;
  if (!id) throw new Error('registerFunction: 模块缺少 id');
  mod.id = id;
  const old = FUNCTION_MAP[id];
  if (old && old !== mod) {
    // 覆盖注册是允许的（热替换），但要说一声，否则同名不同实现会很难查
    console.warn(`[DSP] 覆盖注册同名函数: ${id}`);
    const i = DSPFunctions.indexOf(old);
    if (i >= 0) DSPFunctions.splice(i, 1);
  }
  FUNCTION_MAP[id] = mod;
  DSPFunctions.push(mod);
  return mod;
}

function getFunction(id) { return FUNCTION_MAP[id] || null; }

/* ---------- 形状契约 ----------
 * 'any'      不限
 * 'num[]'    任意长度的数字数组
 * 'vecN'     定长 N（如 vec12 = 12 音级）
 * 'pcm'      非空数字数组（音频块，长度随帧长变）
 * 'scalar'   单个数字
 * 只做"够用的"检查：挡得住把 12 音级接进 128 采样这种错线，
 * 又不用维护一套真正的类型系统。
 */
const SHAPE_RE_VEC = /^vec(\d+)$/;

function isNumArrayLike(v) {
  return !!v && typeof v === 'object' && typeof v.length === 'number';
}

function shapeOk(v, shape) {
  if (!shape || shape === 'any') return true;
  if (shape === 'scalar') return typeof v === 'number';
  if (shape === 'num[]') return isNumArrayLike(v);
  if (shape === 'pcm') return isNumArrayLike(v) && v.length > 0;
  const m = SHAPE_RE_VEC.exec(shape);
  if (m) return isNumArrayLike(v) && v.length === Number(m[1]);
  return true;                       // 不认识的形状名 → 不拦
}

function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'object' && typeof v.length === 'number') return `${v.constructor && v.constructor.name || 'array'}[${v.length}]`;
  return typeof v;
}

/* ---------- 数值容器：跟着输入的类型走，不偷偷降精度 ---------- */
function allocLike(a, n) {
  if (a instanceof Float64Array) return new Float64Array(n);
  if (a instanceof Float32Array) return new Float32Array(n);
  if (Array.isArray(a)) return new Array(n);
  return new Float64Array(n);        // 认不出来就按双精度来（宁可更准）
}

function copyOf(a) {
  if (!isNumArrayLike(a)) throw new Error(`期望数组输入，实际 ${describe(a)}`);
  if (a instanceof Float64Array) return a.slice();
  if (a instanceof Float32Array) return a.slice();
  if (Array.isArray(a)) return a.slice();
  const o = allocLike(a, a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i];
  return o;
}

/* ---------- 适配器：模块的"写法" → 运行时唯一的调用约定 ----------
 * plain  : f(fs) → value                    自己读 fs、自己返回（TopK 这类）
 * scalar : f(x, p, fs) → number             逐元素映射，循环由这里代劳
 * vector : f(a, p, fs) → void|array         整条一起看，可就地改写 a
 * sink   : f(fs, p) → void                  只产生副作用（写端口），输出=输入
 */
const ADAPTERS = {
  plain: (mod, args) => (typeof mod === 'function')
    ? (fs) => mod(fs)
    : (fs) => mod.f(fs, args, fs),

  scalar: (mod, args) => (fs) => {
    const a = fs.INPUT;
    const n = a.length;
    const o = allocLike(a, n);
    for (let i = 0; i < n; i++) o[i] = mod.f(a[i], args, fs);
    return o;
  },

  vector: (mod, args) => (fs) => {
    const a = copyOf(fs.INPUT);      // 不污染上游：旧 OPS 的 f 会就地改写
    const r = mod.f(a, args, fs);
    return r === undefined ? a : r;
  },

  sink: (mod, args) => (fs) => { mod.f(fs, args); return fs.INPUT; },
};

/* ---------- 抽头：每级输出的最近 N 帧（给画布 / 走势图） ---------- */
function tapPush(fs, b, v) {
  const cap = b.tapCap;
  if (!cap) return;
  if (typeof v === 'number') {
    if (!b.win) b.win = WIN(fs, b.key + '/tap', { domain: 'frame', cap });
    wPush(b.win, fs, v);
    return;
  }
  if (!isNumArrayLike(v)) return;
  const n = v.length;
  if (!b.hist || b.hist.n !== n) {
    b.hist = { n, cap, buf: new Float64Array(n * cap), head: 0, count: 0 };
  }
  const h = b.hist;
  h.buf.set(v, h.head * h.n);
  h.head = (h.head + 1) % h.cap;
  if (h.count < h.cap) h.count++;
}

// 从最老到最新读出某一级的输出历史（数组模式下第 k 帧的第 i 个元素）
function tapHistory(b, out) {
  if (b.win) return wRead(b.win, out);
  const h = b.hist;
  if (!h) return null;
  const total = h.count * h.n;
  const a = out && out.length >= total ? out : new Float64Array(total);
  for (let k = 0; k < h.count; k++) {
    const src = ((h.head - h.count + k) % h.cap + h.cap) % h.cap;
    for (let i = 0; i < h.n; i++) a[k * h.n + i] = h.buf[src * h.n + i];
  }
  a.count = h.count; a.n = h.n;
  return a;
}

/* ---------- 绑定：模块 + 实例 → bound ---------- */
function bindFn(mod, inst) {
  inst = inst || {};
  if (!mod || (typeof mod !== 'function' && typeof mod.f !== 'function'))
    throw new Error('bindFn: 模块必须是函数本体，或带 f() 的模块对象');
  const id = mod.id || mod.name || 'fn';
  const key = inst.key || id;
  const kind = mod.kind || 'plain';

  // 参数：schema 默认值兜底 + 实例覆盖。args 是**同一个对象**，
  // 所以调参只需改 args 的字段，不用重新编译整条链。
  // 未在 schema 里声明的实参也放行 —— 接线载荷（子程序引用、寄存器名）不是 UI 可调参数，
  // 但同样要从实例传到模块里。声明过的再用默认值补齐。
  const args = Object.assign({}, inst.args || {});
  for (const p of (mod.paramSchema || [])) {
    // 兼容两套写法：新 schema 用 name/default，旧 OPS / UI 用 key/def
    const pname = p.name || p.key;
    if (!pname || args[pname] !== undefined) continue;
    args[pname] = (p.default !== undefined ? p.default : p.def);
  }

  // 适配器在编译期定型（它闭包住 args），运行期只做一次调用
  const call = (ADAPTERS[kind] || ADAPTERS.plain)(mod, args);

  // 端口：描述符（wired/pin，编译期定死）与数据（value，运行期写）分两个槽。
  // 运行期不再判 wired —— 线接没接不会在帧内变，判一次就够。
  const ports = Object.create(null);
  const swi = Object.create(null);
  for (const name of Object.keys(mod.copyOutSchema || {})) {
    const cs = mod.copyOutSchema[name];
    ports[name] = {
      wired: !!(inst.wired && inst.wired[name]),
      value: undefined,
      pin: cs.defaultPin,
      conflictPolicy: cs.conflictPolicy,
    };
    swi[name] = {
      enabled: (inst.switches && inst.switches[name] !== undefined)
        ? !!inst.switches[name]
        : !!cs.defaultEnabled,
    };
  }

  const outShape = (mod.io && mod.io.out) || 'any';
  const tapCap = inst.tap === undefined ? 0 : inst.tap;

  function bound(fs) {
    if (inst.on === false) {                     // 停用 = 旁路：这一级的"出图"仍等于上一级
      bound.last = fs.INPUT;                     // 抽头也照记，画布上不会出现空洞
      tapPush(fs, bound, fs.INPUT);
      return fs.INPUT;
    }

    fs.FS_ARGS = args;
    fs.FN_SWITCHES = swi;
    fs.DSP_PORTS = ports;
    fs.FN_KEY = key;                             // 资源 key 的命名空间：WIN(fs, key+'/env', …)

    let out;
    try {
      out = call(fs);
    } catch (e) {
      bound.errors++;
      fs.ERROR = { key, id, msg: String((e && e.message) || e) };
      return fs.INPUT;                           // 出错 = 旁路，让后面的链继续跑
    }
    if (out === undefined) out = fs.INPUT;       // sink 类没返回值

    if (!shapeOk(out, outShape)) {
      bound.errors++;
      fs.ERROR = { key, id, msg: `输出形状不符：期望 ${outShape}，实际 ${describe(out)}` };
      return fs.INPUT;
    }
    bound.last = out;
    tapPush(fs, bound, out);
    return out;
  }

  // 暴露给编辑器 / 调试
  bound.id = id;
  bound.key = key;
  bound.kind = kind;
  bound.args = args;
  bound.ports = ports;
  bound.switches = swi;
  bound.last = undefined;
  bound.errors = 0;
  bound.tapCap = tapCap;
  bound.mod = mod;
  return bound;
}

/* ---------- 编译：实例列表 → processor ----------
 * 注意 functions 是**工厂**，DSPRun 每帧会调它；
 * 绑定必须在这里一次做完，绝不能放进工厂里 —— 那样端口/开关状态会每帧被重置。
 */
function compileProcessor(insts, path, opts) {
  opts = opts || {};
  const name = path || 'proc';
  const warnings = [];
  const list = [];

  (insts || []).forEach((it, i) => {
    const inst = Object.assign({}, it.inst, {
      key: (name) + '.' + i,
      tap: (it.inst && it.inst.tap) !== undefined ? it.inst.tap : (opts.tapCap || 0),
    });
    if (it.inst && it.inst.key) inst.key = it.inst.key;     // 允许调用方显式指定（移动位置不丢状态）
    try {
      list.push(bindFn(it.mod, inst));
    } catch (e) {
      warnings.push(`第 ${i} 级绑定失败：${(e && e.message) || e}`);
    }
  });

  return {
    name,
    functions: () => list,        // 稳定的数组：不重建 bound，端口/窗口状态得以跨帧保留
    instances: list,
    warnings,
  };
}

/* ---------- 从「旧 card 结构」编译：{ stages:[{id,on,p}] } ----------
 * 这是改造现有 cards 的唯一入口 —— 一份 Templates/My dsps 的 JSON 进来，
 * 出去的 processor 就能直接塞进 DSP_ARR。
 */
function compileChart(card, path, opts) {
  const stages = (card && card.stages) || [];
  const insts = [];
  const unknown = [];
  for (const st of stages) {
    if (!st || typeof st.id !== 'string') continue;
    const mod = getFunction(st.id);
    if (!mod) { unknown.push(st.id); continue; }         // 未知算子：跳过，记一笔
    insts.push({
      mod,
      inst: { on: st.on !== false, args: st.p || {}, switches: st.switches, wired: st.wired },
    });
  }
  const proc = compileProcessor(insts, path || (card && (card.id || card.title)) || 'chart', opts);
  if (unknown.length) proc.warnings.push(`未知算子：${unknown.join(', ')}`);
  proc.card = card;
  return proc;
}

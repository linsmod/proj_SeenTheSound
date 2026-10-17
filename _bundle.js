// 自动合并生成（server.py func_bundle）：Id.js, Inv.js, Log.js, Log01.js, Lowpass.js, Pow.js, Rank.js, Rescale.js, Tanh.js, TopK.js, Zscore.js

// ==== Id.js ====
'use strict';

/* ============================================================
 * Id —— 恒等（原样透传）
 *
 * 模块契约与 fs 上能拿到的东西见 Inv.js。
 * 这个算子没有"数学"，存在的意义是占位与对照：
 *   · 调试链条时插一级，看它前后的画面是否一致
 *   · 与 on:false 的区别 —— 停用的级连 f 都不会调，恒等级会真的跑一遍
 * ============================================================ */

registerFunction({
  id: 'id',
  kind: 'scalar',
  io: { in: 'num[]', out: 'num[]' },

  label: '恒等',
  description: '原样透传，用来占位或做对照',
  category: '线性',
  tags: '恒等 透传 identity id',

  f: (x) => x,

  paramSchema: [],
});

// ==== Inv.js ====
'use strict';

/* ============================================================
 * Inv —— 单个函数的迁移样板（一个函数一个文件）
 *
 * 编译器（Compile.js）只读这几样：
 *   id            唯一名；Templates / My dsps 里 stages[].id 就是它
 *   kind          调用约定：'scalar' | 'vector' | 'plain' | 'sink'
 *   io            { in, out } 形状契约：'num[]' / 'vec12' / 'pcm' / 'scalar' / 'any'
 *   f             函数本体，签名由 kind 决定
 *   paramSchema   可选。参数默认值 + 控件描述（name / default，兼容旧的 key / def）
 *   copyOutSchema 可选。多输出端口（本例没有，见 TopK.js）
 *
 * kind 决定 f 的签名：
 *   scalar  f(x, p, fs) → number        编译器负责逐元素循环，你只写"一个值怎么变"
 *   vector  f(a, p, fs) → void|array    整条一起看；a 已经是副本，可就地改写
 *   plain   f(fs) → value               自己读 fs.INPUT、自己返回（要接线/多输出时用）
 *   sink    f(fs, p) → void             只产生副作用（写端口/寄存器），输出=输入
 *
 * 运行期能从 fs 上拿到：
 *   fs.INPUT                  上一级的输出（本级的输入）
 *   fs.FS_ARGS                本级实参（schema 默认值 + 实例覆盖）
 *   fs.FN_SWITCHES[name]      端口开关 { enabled }
 *   fs.DSP_PORTS[name]        端口 { wired, value, pin }（wired 编译期定死）
 *   fs.FN_KEY                 本级实例路径 —— 做有状态算子时资源 key 必须以它打头
 *   fs.read(n) / fs.write(n,v)  命名寄存器，跨级接线
 *   fs.run(program, input)    跑一条子链，高阶函数用（可嵌套，不污染外层）
 *
 * 三条约束：
 *   1) 不要就地改 fs.INPUT（vector 适配器已替你复制；scalar 拿到的是单值）
 *   2) 时间一律取 fs.now()，不要 Date.now()（回放要确定）
 *   3) 有状态资源的 key 用 fs.FN_KEY + '/xxx'，否则同一算子出现两次会撞车
 *
 * 想看别的写法：
 *   带参数        → Ops.js 的 pow / tanh / zscore
 *   整条一起算    → Ops.js 的 rescale / rank
 *   多输出 + 端口 → TopK.js
 * ============================================================ */

registerFunction({
  id: 'inv',
  kind: 'scalar',
  io: { in: 'num[]', out: 'num[]' },   // 逐元素，对长度无要求；只想吃 12 音级就写 'vec12'

  label: '1-v 反相',
  description: '把取值反过来：0→1、1→0。谐波分布里等价于"看缺失"，常放链首把"亮"变成"暗"',
  category: '线性',
  tags: '反相 反转 invert 1-x',

  // scalar：循环由编译器代劳，这里只描述"一个值怎么变"
  f: (x) => 1 - x,

  paramSchema: [],                     // 无参数
});

// ==== Log.js ====
'use strict';

/* ============================================================
 * Log —— 自然对数（带下限保护）
 *
 * 注意：输出**不是 0~1**，范围是 [log(1e-3), 0) ≈ [-6.9, 0)。
 * 旧实现里由 computeChart 末端统一 clamp(0,1) 兜住，等于把所有 v<1 都压成负值再夹到 0。
 * 这也是为什么矩阵里"先 log 再归一化"通常要再跟一级 rescale —— 单用这一级只会得到一片 0。
 *
 * io 声明成 num[] 而不是 vec12：它逐元素，长度无关；语义上仍然应该喂归一化后的值。
 * ============================================================ */

registerFunction({
  id: 'log',
  kind: 'scalar',
  io: { in: 'num[]', out: 'num[]' },

  label: 'log',
  description: 'log(max(0,x)+1e-3)，强力拉伸低值。输出可为负，需后接 rescale 或由末端夹紧',
  category: '曲线',
  tags: 'log 对数 ln',

  f: (x) => Math.log(Math.max(0, x) + 1e-3),

  paramSchema: [],
});

// ==== Log01.js ====
'use strict';

/* ============================================================
 * Log01 —— 在 0~1 上做 log，再线性重映射回 0~1
 *
 * 和 Log.js 的区别就是"会不会掉出 0~1"：
 *   Log    : log(x+1e-3)            → ≈ [-6.9, 0]，必须再归一化
 *   Log01  : (log(e+(1-e)x) - log e) / -log e  → [0, 1]，端点严格 0→0、1→1
 * 内部取 e=1e-3，所以 x=0 时分子为 0、分母为 -log(1e-3)，曲线在 0 附近仍是有限值。
 *
 * 这就是 matrix.md 里"归一化后 log"那一格：输入已经是 0~1（比例/概率/视觉权重）时用它，
 * 拉伸低值但不破坏 0~1 的边界。
 * ============================================================ */

registerFunction({
  id: 'log01',
  kind: 'scalar',
  io: { in: 'num[]', out: 'num[]' },

  label: 'log(0~1)',
  description: '在 0~1 上做 log 后线性重映射回 0~1（0→0、1→1），拉伸低值且不越界',
  category: '曲线',
  tags: 'log 0~1 归一化后',

  f: (x) => { const e = 1e-3; return (Math.log(e + (1 - e) * x) - Math.log(e)) / -Math.log(e); },

  paramSchema: [],
});

// ==== Lowpass.js ====
'use strict';

/* ============================================================
 * Lowpass —— 低通(时间)：对每个音级的 SFM 时间序列做一阶 IIR（指数平滑）
 *
 * 有状态算子样板（在 fs.hold 这类 helper 出现之前的"正确手写姿势"）：
 *   · 跨帧状态走 ST()，key 必须以 fs.FN_KEY 打头（多实例隔离）
 *   · 时间基准用 fs.TS（DSPRun 每帧设一次，同帧所有算子一致），不要各算子调 fs.now()
 *   · dt 首帧/异常给缺省，并 clamp（暂停恢复、切页回来都不会让滤波器炸）
 *   · 上一帧输出不允许用 `||` 判空 —— 0 是合法输出
 * ============================================================ */

registerFunction({
  id: 'lowpass',
  kind: 'vector',
  io: { in: 'vec12', out: 'vec12' },
  // 需要 fs（跨帧状态 ST/TS）—— 是否需要帧状态由页面按"f 源码是否引用 fs"自动检测，无需声明

  label: '低通(时间)',
  description: '一阶 IIR：对每个音级的 SFM 时间序列做指数平滑，压掉帧间抖动',
  category: '滤波',
  tags: 'filter lowpass 平滑 ema iir 滤波',

  paramSchema: [
    { name: 'fc', label: '截止Hz', type: 'number', default: 2,
      control: { type: 'NumberBox', fractionDigits: 1, step: 0.5, min: 0.1, max: 20 } },
  ],

  f: (a, p, fs) => {
    // 跨帧状态：ST 记录 { y: 上一帧输出, t: 上一帧 TS }。长度变了重建 = 从当前输入重新起步。
    const rec = ST(fs, fs.FN_KEY + '/lp', { y: null, t: null }).value;
    if (!rec.y || rec.y.length !== a.length) rec.y = Float64Array.from(a);

    // dt 用 fs.TS 差分（同帧恒定）；首帧给 20ms（50Hz 标称），之后钳 1ms~250ms（暂停恢复 / 切页兜底）
    const dt = (rec.t == null) ? 0.02
        : Math.min(0.25, Math.max(0.001, (fs.TS - rec.t) / 1000));
    rec.t = fs.TS;

    const alpha = 1 - Math.exp(-2 * Math.PI * Math.max(0.05, p.fc) * dt);
    for (let i = 0; i < a.length; i++) {
      rec.y[i] += alpha * (a[i] - rec.y[i]);   // 显式首帧起步（rec.y 已拷贝 a），不存在 || 判零问题
      a[i] = rec.y[i];                          // 就地改写 a（副本），交给下一级
    }
  },

  paramSchema: [],
});

// ==== Pow.js ====
'use strict';

/* ============================================================
 * Pow —— scalar + 参数 的样板
 *
 * 三个要点：
 *   1) 参数从 fs.FS_ARGS 读，字段名就是 paramSchema 里的 name；
 *      编译期已经把"实例覆盖 → schema 默认值"填好了，这里不用再判 undefined。
 *   2) 调参只改 args 对象的字段，**不会重新编译**（bindFn 的 args 是同一个对象），
 *      所以这里每次调用现读即可，不要闭包缓存。
 *   3) 负数底数在实数域没有意义：沿用旧实现的 Math.max(0, x) 夹到 0，
 *      这样 n 为非整数时不会得到 NaN。
 * ============================================================ */

registerFunction({
  id: 'pow',
  kind: 'scalar',
  io: { in: 'num[]', out: 'num[]' },

  label: '幂',
  description: 'x^n。n>1 放大高值、压低压值；n<1 拉伸低值',
  category: '曲线',
  tags: '幂 平方 幂次 power',

  f: (x, p) => Math.pow(Math.max(0, x), p.n),

  paramSchema: [
    { key: 'n', name: 'n', label: 'n', type: 'range', min: 0.1, max: 4, step: 0.1, def: 2, default: 2 },
  ],
});

// ==== Rank.js ====
'use strict';

/* ============================================================
 * Rank —— vector 类算子的迁移样板
 *
 * 与 Inv.js 互补：那个讲 scalar（一个值怎么变），这个讲 vector（整条一起看）。
 * 模块契约全文见 Inv.js，这里只强调 vector 特有的三件事：
 *
 *   1) 传进来的 a **已经是副本**（适配器 copyOf 过），就地改写是安全的，
 *      不会污染上游那一级的输出 —— 这是旧 OPS 里 `f(a)` 直接改数组的写法能原样搬过来的原因。
 *
 *   2) 但"读原值"的算子（本文件就是）必须在写之前自己快照一份，
 *      否则算到第 i 个元素时，前面已经写进去的秩会污染后面元素的比较。
 *
 *   3) 临时缓冲挂在 fs.FN_KEY 命名空间下复用，不要每帧新建：
 *      50Hz × 每格每级一次 new Float64Array(12)，在十几条链上就是每秒几千次分配。
 *      用 ST(fs, fs.FN_KEY + '/tmp', null) 存一份，长度变了再重开。
 *
 * 算法（与旧 OPS 逐字一致）：把当前帧的值换成 0~1 的"平均秩"。
 *   less  = 比 x 小的个数
 *   equal = 与 x 相等的个数（并列）
 *   秩     = (less + (equal-1)/2) / (n-1)      ← 并列取这段秩的中点
 * 全部相等时没有排序可言，统一给 0.5。
 * ============================================================ */

registerFunction({
  id: 'rank',
  kind: 'vector',
  io: { in: 'vec12', out: 'vec12' },     // 整条一起看；想放宽到任意长度就写 'num[]'

  label: '分位秩',
  description: '按当前帧把 12 个值换成 0~1 的平均秩（并列取平均），只保留排序、丢掉幅度',
  category: '归一化',
  tags: 'rank 分位 秩 percentile 排序',

  // vector：a 已是副本，可就地改写；返回值留空表示"用 a"
  f: (a, p, fs) => {
    const n = a.length;

    // ① 先看极差：全部相等 → 没有排序，统一 0.5
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { const v = a[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx - mn <= 1e-9) { for (let i = 0; i < n; i++) a[i] = 0.5; return; }

    // ② 快照原值：写回时 a 会被覆盖，比较必须对着快照做
    const slot = ST(fs, (fs.FN_KEY || 'rank') + '/tmp', null);
    let tmp = slot.value;
    if (!tmp || tmp.length !== n) { tmp = new Float64Array(n); slot.value = tmp; }
    for (let i = 0; i < n; i++) tmp[i] = a[i];

    // ③ 逐个算平均秩
    for (let i = 0; i < n; i++) {
      const x = tmp[i];
      let less = 0, equal = 0;
      for (let q = 0; q < n; q++) {
        if (tmp[q] < x - 1e-12) less++;                 // 严格更小
        else if (tmp[q] <= x + 1e-12) equal++;           // 与 x 并列（含自身）
      }
      a[i] = (less + (equal - 1) / 2) / (n - 1);
    }
  },

  paramSchema: [],                        // 无参数
});

// ==== Rescale.js ====
'use strict';

/* ============================================================
 * Rescale —— vector 类：按当前帧的极差拉满到 0~1
 *
 * 与 Rank.js 的对比（两个都是 vector，但写法不同）：
 *   Rescale：先扫一遍求出 min/max，再整体写回 —— **不需要快照**，
 *            因为第一步只读不写，第二步只写不读。
 *   Rank   ：每个元素的秩依赖"其他元素的原值"，所以必须先快照一份。
 *
 * 这条分界线值得记住：**写之前是否还要读原值**。不需要就别多复制一份。
 *
 * 退化分支（极差≈0）给 0.5 而不是 0：
 * 静止/静音时所有音级一样，给 0 会把画面压成纯黑，给 0.5 才是"无差别"的正确表达。
 * ============================================================ */

registerFunction({
  id: 'rescale',
  kind: 'vector',
  io: { in: 'vec12', out: 'vec12' },

  label: '重缩放',
  description: '按当前帧 12 音级的 min/max 拉满到 0~1；极差≈0 时统一居中 0.5',
  category: '归一化',
  tags: '归一化 minmax rescale 重缩放',

  f: (a) => {
    const n = a.length;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { const v = a[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const rg = mx - mn;
    for (let i = 0; i < n; i++) a[i] = rg > 1e-9 ? (a[i] - mn) / rg : 0.5;
  },

  paramSchema: [],
});

// ==== Tanh.js ====
'use strict';

/* ============================================================
 * Tanh —— scalar + 参数，且是"两端压缩、中间放大"的 S 曲线
 *
 * 算式拆开看：
 *   0.5 + 0.5 * tanh(k*(x-0.5)) / tanh(k/2)
 *   ├─ (x-0.5)   先把 0~1 平移到以 0 为中心
 *   ├─ tanh(k*·) 压两端
 *   └─ ÷tanh(k/2) 归一化，保证 x=1 时回到 1（x=0 时回到 0）
 * k 越大曲线越陡、越接近阶跃；k=1 时几乎是线性。
 * ============================================================ */

registerFunction({
  id: 'tanh',
  kind: 'scalar',
  io: { in: 'num[]', out: 'num[]' },

  label: 'tanh',
  description: '以 0.5 为中心做 tanh 压缩：两端压缩、中间放大，k 越大越接近阶跃',
  category: '曲线',
  tags: 'tanh sigmoid s曲线 压缩',

  f: (x, p) => 0.5 + 0.5 * Math.tanh(p.k * (x - 0.5)) / Math.tanh(p.k / 2),

  paramSchema: [
    { key: 'k', name: 'k', label: 'k', type: 'range', min: 1, max: 20, step: 0.5, def: 6, default: 6 },
  ],
});

// ==== TopK.js ====
'use strict';

/* ============================================================
 * TopK：返回数组中最大的 k 个元素；可选把「剩余元素 / 前 k 个」写到端口。
 *
 * 写法要点（也是给其它模块的样板）：
 *   · 先声明函数，再挂元数据 —— 反过来会被 `TopK = function(){}` 把元数据冲掉
 *   · 端口写入走 DSP_PORTS[name].value（描述符与数据分两个槽）
 *   · wired 由编译期决定，运行期不再判断"线有没有接"
 *   · 不就地改 fs.INPUT，避免污染上游
 * ============================================================ */

var copyOut = function (fs, which, data) {
    var p = fs.DSP_PORTS && fs.DSP_PORTS[which];
    var sw = fs.FN_SWITCHES && fs.FN_SWITCHES[which];
    if (p && p.wired && sw && sw.enabled) p.value = data;
};

function TopK(fs) {
    var arr = fs.INPUT;
    var n = arr.length;
    var args = fs.FS_ARGS || {};

    // k 防御：非法 / 缺省 → paramSchema 的默认值；取整 + 超出范围截断
    var k = Number(args.K);
    if (!isFinite(k)) k = 10;
    k = Math.round(k);
    if (k < 0) k = 0;
    if (k > n) k = n;

    // k=0：不需要排序，top 恒空，rest 就是原数组
    if (k === 0) {
        copyOut(fs, 'dupRest', arr.slice());
        copyOut(fs, 'dupOut', arr.slice(0, 0));
        return arr.slice(0, 0);          // 与 k>0 的返回类型保持一致（不返回裸 []）
    }

    // 不污染上游：复制后排序（原地 sort 会改上游数组的顺序）
    var sorted = arr.slice().sort(function (a, b) { return b - a; });
    var top = sorted.slice(0, k);

    copyOut(fs, 'dupRest', sorted.slice(k));
    copyOut(fs, 'dupOut', top);
    return top;
}

TopK.id = 'TopK';
TopK.kind = 'plain';                       // 自己读 fs、自己返回（不走 scalar/vector 适配器）
TopK.io = { in: 'num[]', out: 'num[]' };
TopK.description = '返回数组中最大的 k 个元素；可选把剩余元素 / 前 k 个写到端口';
TopK.category = '选择';
TopK.tags = '选择 最大 前k topk topn top';
TopK.paramSchema = [
    {
        name: 'K',
        label: 'K',
        type: 'number',
        default: 10,
        control: {
            type: 'NumberBox',
            fractionDigits: 0,               // 整数：显示与存档都取整
            step: 1,                         // 可为 fn
            min: 1,                          // 可为 fn
            max: (ctx) => ctx.input.length,  // 上限跟输入长度走（UI 重建时求值；存档清洗跳过 fn 边界）
        },
    },
];

// 东南西北 ESWN 四边
TopK.copyOutSchema = {
    dupRest: {
        defaultPin: 'dsppin-S0',
        conflictPolicy: 'CW-next',
        defaultEnabled: false,
        switchable: true,
        hint: '复制剩余元素（第 k+1 个之后）',
    },
    dupOut: {
        defaultPin: 'dsppin-S1',
        conflictPolicy: 'CW-next',
        defaultEnabled: false,
        switchable: true,
        hint: '复制前 k 个（= 返回值的那份）',
    },
};

if (typeof registerFunction === 'function') registerFunction(TopK);
else DSPFunctions.push(TopK);

// ==== Zscore.js ====
'use strict';

/* ============================================================
 * Zscore —— vector + 参数（两种样板合在一起）
 *
 * 三步：
 *   ① 求 μ                    （第一遍：只读）
 *   ② 求 σ 并把 ±zMax 映射到 0~1（第二遍：读 a[i] → 写 a[i]，同下标进出，安全）
 *   ③ 结束
 *
 * 为什么这里不需要快照（对比 Rank.js）：
 *   第二遍是 `z = (a[i]-mean)/sd` 然后 `a[i] = …`，读写同一个下标，
 *   前面元素的改写不会影响后面元素的输入。Rank 做不到这点 —— 它每个元素都要跟"整条原值"比。
 *
 * zMax 的意义：σ 之外的离群点会被夹住，避免一个尖峰把其余 11 个压成一条直线。
 * zMax 越小越"抗尖峰"，越大越保留极端值。
 * ============================================================ */

registerFunction({
  id: 'zscore',
  kind: 'vector',
  io: { in: 'vec12', out: 'vec12' },

  label: 'z-score',
  description: '按当前帧算 μ/σ，±zMax 夹紧后线性映射到 0~1；对整体音量涨落免疫',
  category: '归一化',
  tags: 'zscore 标准化 均值 方差 standard',

  f: (a, p) => {
    const n = a.length;

    // ① 均值
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i];
    const mean = sum / n;

    // ② 标准差（人口标准差：除 n，不是 n-1）
    let q = 0;
    for (let i = 0; i < n; i++) { const d = a[i] - mean; q += d * d; }
    const sd = Math.sqrt(q / n), zm = p.zMax || 2;

    // ③ 夹紧 + 映射（同下标读写，不需要快照）
    for (let i = 0; i < n; i++) {
      const z = sd > 1e-9 ? (a[i] - mean) / sd : 0;
      a[i] = (Math.max(-zm, Math.min(zm, z)) + zm) / (2 * zm);
    }
  },

  paramSchema: [
    { key: 'zMax', name: 'zMax', label: '±z', type: 'range', min: 1, max: 4, step: 0.1, def: 2, default: 2 },
  ],
});
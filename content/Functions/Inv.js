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
  category: '归一化前',
  tags: '反相 反转 invert 1-x',

  // scalar：循环由编译器代劳，这里只描述"一个值怎么变"
  f: (x) => 1 - x,

  paramSchema: [],                     // 无参数
});

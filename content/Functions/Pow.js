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
  category: '归一化前',
  tags: '幂 平方 幂次 power',

  f: (x, p) => Math.pow(Math.max(0, x), p.n),

  paramSchema: [
    { key: 'n', name: 'n', label: 'n', type: 'range', min: 0.1, max: 4, step: 0.1, def: 2, default: 2 },
  ],
});

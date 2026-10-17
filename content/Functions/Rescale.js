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
  category: '归一化内',
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

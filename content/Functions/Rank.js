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

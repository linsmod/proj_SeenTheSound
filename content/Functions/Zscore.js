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
  description: '按当前帧算 μ/σ，±zMax 夹紧后线性映射到 0~1；对整体幅度的共同涨落免疫（整体变大变小不改变彼此相对位置）',
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

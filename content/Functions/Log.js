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
  category: '归一化前',
  tags: 'log 对数 ln',

  f: (x) => Math.log(Math.max(0, x) + 1e-3),

  paramSchema: [],
});

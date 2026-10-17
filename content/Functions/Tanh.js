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
  category: '归一化后',
  tags: 'tanh sigmoid s曲线 压缩',

  f: (x, p) => 0.5 + 0.5 * Math.tanh(p.k * (x - 0.5)) / Math.tanh(p.k / 2),

  paramSchema: [
    { key: 'k', name: 'k', label: 'k', type: 'range', min: 1, max: 20, step: 0.5, def: 6, default: 6 },
  ],
});

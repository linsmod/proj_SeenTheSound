'use strict';

/* ============================================================
 * fold —— 音级折叠：bin 级输入（num[]）→ 12 音级（vec12）
 *
 * 上游：input(src='spec.raw')。音级映射（bin → 最近音 → 音级）由页面喂进
 * fs.PC_BINS —— 与三个 vec12 缓冲共享同一分拣口径，声明归链、映射归页面。
 *
 * mode：
 *   mean  均值 —— 平滑但弱 bin 稀释强 bin（峰不突出）
 *   max   最大 —— 峰值口径，尖峰保真；对孤立 bin 噪声敏感
 *
 * f 引用了 fs（读 PC_BINS/ST）→ needsFs 自动检出 → 旧整窗批算路径不可比，
 * 自检对含 fold 的图按 needsFs 待遇跳过（变长输入的旧路径基准不存在）。
 * ============================================================ */

registerFunction({
  id: 'fold',
  kind: 'vector',
  io: { in: 'num[]', out: 'vec12' },

  label: '音级折叠',
  description: '把 bin 级输入按音级映射折成 12 通道：mean 平滑（弱 bin 稀释峰）或 max 保峰。应紧跟 input(src=spec.raw)',
  category: '输入',
  tags: 'fold 折叠 音级 均值 最大 mean max',

  paramSchema: [
    { name: 'mode', label: '折叠方式', type: 'select', def: 'mean',
      control: { type: 'DropdownList', options: [{ v: 'mean', t: '均值' }, { v: 'max', t: '最大值' }] } },
  ],

  // 私有工作区声明：输出暂存（每帧复用，避免 50Hz × 每链一次的分配）
  state: [
    { key: '/out', shape: 'Float64Array(12)', note: '折叠结果暂存；下游拿到的是副本，复用安全' },
  ],

  f: (a, p, fs) => {
    const rec = ST(fs, fs.FN_KEY + '/out', null);
    let o = rec.value;
    if (!o || o.length !== 12) o = rec.value = new Float64Array(12);

    const bins = fs.PC_BINS;                 // 页面喂：pc → [bin,...]（与缓冲同口径）
    const max = p.mode === 'max';
    for (let pc = 0; pc < 12; pc++) {
      const bl = bins ? bins[pc] : null;
      if (!bl || !bl.length) { o[pc] = 0; continue; }
      if (max) {
        let m = 0;
        for (let k = 0; k < bl.length; k++) { const v = a[bl[k]] || 0; if (v > m) m = v; }
        o[pc] = m;
      } else {
        let s = 0;
        for (let k = 0; k < bl.length; k++) s += (a[bl[k]] || 0);
        o[pc] = s / bl.length;
      }
    }
    return o;
  },
});

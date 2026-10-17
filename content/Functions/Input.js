'use strict';

/* ============================================================
 * Input —— 输入源（声明式算子）
 *
 * 这一级**不做数学**：f 是恒等，它存在的意义是让"本条链从哪个源取数"
 * 成为链的一部分（存进 stages，跟链一起保存/复制/改名），而不是页面级的全局开关。
 *
 * 契约（谁做什么）：
 *   · 本级 paramSchema.src —— 用户在参数面板里选（InputSourcePicker，可用性随流变化）
 *   · 宿主页面（dsp-lab）在喂 INPUT 那层读 p.src：链里**第一个启用**的 input 级生效，
 *     src 非法或没写 input 级 → 回落页面全局默认（顶栏选择器）
 *   · f 恒等 —— 把它放链中间等于没有；放首级才能表达"从哪取数"
 *
 * 为什么不让 f 自己去取数：源缓冲住在宿主页面（sfmDisp/specDisp/gateDisp），
 * 运行时核心（Compile/Processor）对它们一无所知 —— 声明归链、取数归页面，
 * 这一级才能同时活在增量路径（runColumn）和自检的整窗批算路径里。
 * ============================================================ */

registerFunction({
  id: 'input',
  kind: 'vector',
  io: { in: 'vec12', out: 'vec12' },

  label: '输入源',
  description: '声明本条链从哪个源取数（应放首级；取数由页面按 p.src 做，本级本身恒等）',
  category: '输入',
  tags: '输入 input source 源 选择',

  paramSchema: [
    { name: 'src', label: '输入源', type: 'select', def: 'sfm.matrix',
      control: { type: 'InputSourcePicker' } },
  ],

  f: (a) => a,
});

'use strict';

/* ============================================================
 * InputSourcePicker —— 输入源下拉（基于 DropdownList）
 *
 * 与具体页面解耦：选项来自宿主页面声明的 hook
 *   window.dspInputSources(ctx) → [{ v, t, disabled? }]
 * 宿主没接 hook（组件库单独试用 / 其他页面）→ 退回内置三源静态表，
 * 保证控件永远有东西可选，而不是空着。
 *
 * options 按.fn 传给 DropdownList —— 源的可用性随流变化（--no-gate 时 gate
 * 置灰，流里出现 gate 字段后放开），宿主在翻转时调 refresh()（或重绘参数区）即可。
 * ============================================================ */

(function () {
    const UIControls = window.UIControls;
    if (!UIControls) throw new Error('InputSourcePicker 需要先载入 UIControls.js');
    if (!UIControls.WIDGETS.DropdownList) throw new Error('InputSourcePicker 需要先载入 DropdownList.js');

    const FALLBACK = [
        { v: 'sfm.matrix', t: 'SFM 平坦度' },
        { v: 'spec.fft', t: '频谱电平（音级折叠）' },
        { v: 'gate.grid', t: '门控增益（9 音区 max）' },
    ];

    UIControls.registerControl('InputSourcePicker', function (spec, api) {
        // 宿主 hook 优先；拿不到就用静态表。异常同样兜底 —— 选择器炸了不能拖死整条链的参数面板
        const opts = (ctx) => {
            let list = null;
            try { list = (window.dspInputSources && window.dspInputSources(ctx)) || null; } catch (e) { list = null; }
            return list || FALLBACK;
        };
        return UIControls.WIDGETS.DropdownList(Object.assign({}, spec, { options: opts }), api);
    });
})();

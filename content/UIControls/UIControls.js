'use strict';

/* ============================================================
 * UIControls —— 参数控件组件库（content/UIControls/，一个控件一个文件）
 *
 * 页面按需 <script src> 引入；与 Functions 同一套思路，但注册的是 UI 控件。
 *
 * 契约（paramSchema → 归一 spec）：
 *   顶层字段是"简写"（type/min/max/step/def/default），control 块逐键覆盖：
 *     { type: 'NumberBox', fractionDigits: 0, step: 1,
 *       min: 1, max: (ctx) => 12,          // fn 边界：UI 重建时求值一次，静态层跳过钳位
 *       shiftStepFactor / ctrlStepFactor / midClickReset: true|false|fn }  // 未实现键按预设继承
 *   type ∈ 'range'（滑杆，浮点）| 'number'（数字框）| 'select'（下拉，配 options）；
 *   'int' 视为 number + fractionDigits 0（老写法兼容，不建议再写）。
 *
 * 归一产物 normalizeParam(s)：
 *   { key, label, type, widget, min, max, step, fractionDigits, options, control, def }
 *   def 已按静态边界钳位、按 fractionDigits 取整 —— 显示整数 ≠ 存档整数的坑在这层堵住。
 * ============================================================ */

(function () {
    const UIControls = (window.UIControls = window.UIControls || {});

    UIControls.WIDGETS = {};

    UIControls.registerControl = function (name, factory) {
        if (typeof factory !== 'function') throw new Error('registerControl: ' + name + ' 需要工厂函数');
        // 来源归属：控件文件是逐个 <script> 同步载入的，currentScript 就是"现在这份"——
        // 元数据视图 / 树的虚拟叶子靠它把"控件 → 住在哪个 .js"对上号（与 Functions 的 DSP_SRC_FILE 等价）
        try {
            const cs = document.currentScript;
            factory.srcFile = (cs && cs.src) ? cs.src.split('/').pop() : '';
        } catch (e) { factory.srcFile = ''; }
        UIControls.WIDGETS[name] = factory;
    };

    // 'inherit' 的预设表住在组件里，schema 只允许 true/false/fn 覆盖。
    // v1 未实现的键（滚轮倍率 / 中键重置 / 方向键行为）按预设继承、静默忽略 —— schema 先行不阻塞。
    UIControls.PRESETS = { shiftStepFactor: 10, ctrlStepFactor: 0.1, midClickReset: true };

    // 值格式化：fractionDigits 控制小数位（缺省 2，0 = 整数）
    UIControls.fmt = function (v, digits) {
        if (typeof v !== 'number') return String(v);
        if (!isFinite(v)) return String(v);
        return v.toFixed(Math.max(0, digits == null ? 2 : digits));
    };

    /* normalizeParam(s) → 统一 spec（见文件头契约） */
    UIControls.normalizeParam = function (s) {
        if (!s || typeof s !== 'object') s = {};
        let type = s.type || 'range';
        const c = (s.control && typeof s.control === 'object') ? s.control : {};
        if (type === 'int') type = 'number';                 // 老写法兼容：整数用 fractionDigits:0 表达
        if (type !== 'number' && type !== 'select') type = 'range';

        const first = (a, b) => (a !== undefined) ? a : b;
        const min = first(c.min, s.min != null ? s.min : null);
        const max = first(c.max, s.max != null ? s.max : null);
        const step = first(c.step, s.step != null ? s.step : null);
        let fractionDigits = first(c.fractionDigits, 2);
        if (typeof fractionDigits !== 'number' || !isFinite(fractionDigits)) fractionDigits = 2;
        fractionDigits = Math.max(0, Math.round(fractionDigits));

        const widget = first(c.type, type === 'range' ? 'range' : (type === 'select' ? 'select' : 'NumberBox'));

        let def = first(s.def, first(s.default, 0));
        if (typeof def === 'number') {                        // 静态边界是 fn 时跳过钳位（运行期算子自己兜底）
            if (typeof min === 'number') def = Math.max(min, def);
            if (typeof max === 'number') def = Math.min(max, def);
            if (fractionDigits === 0) def = Math.round(def);
        }

        return {
            key: s.key || s.name,
            label: s.label || s.key || s.name || '?',
            type, widget, min, max, step, fractionDigits,
            options: Array.isArray(s.options) ? s.options : null,
            control: c,                                       // 原样带上：滚轮倍率等覆盖项，控件自己读
            def,
        };
    };
})();

'use strict';

/* ============================================================
 * NumberBox —— 数字输入控件
 *
 * spec = normalizeParam 的产物；min/max/step 可以是 (ctx) => 值 的纯函数
 *（UI 只在控件重建时求值一次；静态存档清洗会跳过 fn 边界，由算子运行期自己兜底）。
 *
 * 工厂：(spec, api) → { el, refresh() }
 *   api.get()      读当前值（写回目标在调用方，控件不持有数据）
 *   api.commit(v)  写回 + 通知（调用方负责刷新值显示与 onChange）
 *   api.ctx()      fn 边界的求值上下文（如 { input: 当前帧 12 音级 }）；缺省给 {}
 *
 * 行为：
 *   · fractionDigits === 0 → 输入取整（显示与写入都取整）
 *   · 失焦回读 api.get()：显示与存档永远一致
 *   · 未实现（按 UIControls.PRESETS 继承，占位）：滚轮步进倍率、中键重置、方向键行为
 * ============================================================ */

(function () {
    const UIControls = window.UIControls;
    if (!UIControls) throw new Error('NumberBox 需要先载入 UIControls.js');

    function resolve(v, ctx, fb) {
        if (typeof v === 'function') {
            try { v = v(ctx); } catch (e) { return fb; }    // fn 边界算炸了 → 退回缺省，不炸控件
        }
        return (v == null || (typeof v === 'number' && !isFinite(v))) ? fb : v;
    }

    UIControls.registerControl('NumberBox', function (spec, api) {
        const digits = (typeof spec.fractionDigits === 'number') ? Math.max(0, spec.fractionDigits) : 2;
        const el = document.createElement('input');
        el.type = 'number';
        const ctx = api.ctx || function () { return {}; };

        const bounds = () => ({
            min: resolve(spec.min, ctx(), null),
            max: resolve(spec.max, ctx(), null),
        });
        const b0 = bounds();
        if (b0.min != null) el.min = b0.min;
        if (b0.max != null) el.max = b0.max;
        el.step = resolve(spec.step, ctx(), digits === 0 ? 1 : 'any');

        const clamp = (v) => {
            const b = bounds();
            if (typeof v !== 'number' || !isFinite(v)) v = api.get();
            if (b.min != null) v = Math.max(b.min, v);
            if (b.max != null) v = Math.min(b.max, v);
            return digits === 0 ? Math.round(v) : v;
        };

        el.value = api.get();
        el.addEventListener('input', () => {
            const v = clamp(parseFloat(el.value));
            el.value = v;                     // 取整/钳位立刻回显，别让框里留着越界值
            api.commit(v);
        });
        el.addEventListener('change', () => { el.value = api.get(); });

        return { el, refresh: () => { el.value = api.get(); } };
    });
})();

'use strict';

/* ============================================================
 * DropdownList —— 下拉选择控件
 *
 * spec = normalizeParam 的产物；options 支持**静态数组或 (ctx) => 数组**：
 *   [{ v: 值, t: 显示文本, disabled: true|false }, ...]
 * options 是 fn 时（如 InputSourcePicker 的"可用性随流变化"），refresh() 会重解析。
 *
 * 工厂：(spec, api) → { el, refresh(), describe(v) }
 *   api.get()      读当前值（写回目标在调用方，控件不持有数据）
 *   api.commit(v)  写回 + 通知（调用方负责刷新值显示与 onChange）
 *   api.ctx()      fn options 的求值上下文；缺省给 {}
 *   describe(v)    值 → 显示文本（调用方拿去刷参数值标签，别显示裸 id）
 *
 * 行为：
 *   · 当前值不在选项里 / 落在 disabled 项上 → 显示回落到第一个可用项，**不回写**
 *     （显示归显示，真值由运行期校验兜底 —— 控件不偷偷改存档）
 *   · change → commit(option 原始 v)（不经过任何钳位，值域归 options 声明者管）
 * ============================================================ */

(function () {
    const UIControls = window.UIControls;
    if (!UIControls) throw new Error('DropdownList 需要先载入 UIControls.js');

    UIControls.registerControl('DropdownList', function (spec, api) {
        const ctx = api.ctx || function () { return {}; };
        const el = document.createElement('select');
        let cur = [];

        const resolve = () => {
            let o = spec.options;
            if (typeof o === 'function') {
                try { o = o(ctx()); } catch (e) { o = null; }   // fn options 算炸 → 当空表，不炸控件
            }
            cur = (Array.isArray(o) ? o : []).filter((x) => x && x.v != null);
        };

        const sync = () => {
            const v = api.get();
            const hit = cur.find((o) => o.v === v && !o.disabled);
            el.value = hit ? v : ((cur.find((o) => !o.disabled) || { v: '' }).v);
        };

        const rebuild = () => {
            resolve();
            el.textContent = '';
            for (const o of cur) {
                const op = document.createElement('option');
                op.value = o.v;
                op.textContent = (o.t != null) ? o.t : String(o.v);
                if (o.disabled) op.disabled = true;
                el.appendChild(op);
            }
            sync();
        };
        rebuild();

        el.addEventListener('change', () => api.commit(el.value));

        return {
            el,
            refresh: rebuild,
            describe: (v) => {
                const o = cur.find((o) => o.v === v);
                return o ? ((o.t != null) ? o.t : String(o.v)) : String(v);
            },
        };
    });
})();

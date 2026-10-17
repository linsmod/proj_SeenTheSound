'use strict';

/* ============================================================
 * Views —— 面板视图注册表（content/Views/，一个视图一个文件）
 *
 * 与 VIEW_IMPL 的分工：VIEW_IMPL（dsp-lab 内联）放页面强耦合的三个基础视图
 * （dsplistview/dspview/fnview）；本目录放"机制可视化"这类独立视图，往外迁的时候
 * 逐个搬进来。注册表约定与 VIEW_IMPL 同形，另加两个生命周期钩子：
 *
 *   registerView({
 *     id: 'bufview',
 *     mount(p)   → 实例（存进 p._vi）；建 DOM、登记画布
 *     tick(inst) 每帧（页面主循环调用）→ 实例自己判断 el.hidden / isConnected 决定画不画
 *     destroy(p, inst) → 释放（从画册摘除；DOM 由 paneDetach 统一清）
 *   })
 *
 * 页面接线（dsp-lab.html）：viewerOf 对目录键读 DIR_META.viewtype；
 * VIEW_IMPL.bufview = Views.get('bufview')；主循环里 Views.tick()。
 * ============================================================ */

(function () {
    const Views = (window.Views = window.Views || {});
    const REG = new Map();

    Views.registerView = function (v) {
        if (!v || !v.id || typeof v.mount !== 'function') throw new Error('registerView: 需要 id 与 mount()');
        try {
            const cs = document.currentScript;
            v.srcFile = v.srcFile || ((cs && cs.src) ? cs.src.split('/').pop() : '');
        } catch (e) { v.srcFile = v.srcFile || ''; }
        if (REG.has(v.id)) console.warn('[Views] 覆盖注册同名视图: ' + v.id);
        REG.set(v.id, v);
        return v;
    };

    Views.get = (id) => REG.get(id) || null;
    Views.all = () => Array.from(REG.values());

    // 每帧：让各视图实例自己决定画不画（隐藏/离树的跳过）。实例集合由各视图自管。
    Views.tick = function () {
        for (const v of REG.values()) if (v.tick) v.tick();
    };
})();

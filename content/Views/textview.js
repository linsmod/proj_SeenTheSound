'use strict';

/* ============================================================
 * textview —— 默认文本视图（srcview）
 *
 * 给"没有绑视图的文件"兜底：content/ 下四类源码（算子/控件/缓冲/视图）都是实体
 * .js 文件，树里单击 → 只读源码（行号 gutter + 等宽 pre）。不自管节拍、无 tick。
 *
 * 内容直接 fetch p.key（各代码目录的路由只放行 .js，no-cache —— 改完刷新即最新）。
 * 文件被删/路由不在 → 显示错误行，不给整页炸。
 * ============================================================ */

(function () {
    const LIVE = [];

    Views.registerView({
        id: 'srcview',

        mount(p) {
            const host = p.el;
            host.textContent = '';
            const bar = document.createElement('div');
            bar.className = 'st';
            bar.textContent = '读取 ' + p.key + ' …';
            host.appendChild(bar);
            const inst = { p, bar, aborted: false };
            LIVE.push(inst);

            fetch(p.key, { cache: 'no-store' })
                .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
                .then((txt) => {
                    if (inst.aborted) return;                 // 期间被重挂/关掉
                    bar.textContent = p.key;
                    const lines = txt.replace(/\t/g, '    ').replace(/\r\n/g, '\n').split('\n');
                    const wrap = document.createElement('div');
                    wrap.setAttribute('data-scroller', '');   // 页面据此把滚动捕获/还原接到这个容器上
                    wrap.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;align-items:flex-start;gap:0;background:#0a1022;border:1px solid rgba(255,255,255,0.10);border-radius:6px;overflow:auto;';
                    const gut = document.createElement('div');
                    gut.style.cssText = 'flex:none;padding:8px 6px;text-align:right;color:#5a6c94;font-family:Consolas,monospace;font-size:12px;line-height:1.45;white-space:pre;user-select:none;border-right:1px solid rgba(255,255,255,0.08);';
                    gut.textContent = lines.map((_, i) => i + 1).join('\n');
                    const pre = document.createElement('pre');
                    pre.style.cssText = 'flex:1 1 auto;margin:0;padding:8px 10px;color:#c4d2ee;font-family:Consolas,monospace;font-size:12px;line-height:1.45;white-space:pre;';
                    pre.textContent = txt;
                    wrap.append(gut, pre);
                    host.appendChild(wrap);
                })
                .catch((e) => {
                    if (inst.aborted) return;
                    bar.textContent = '❌ 读取失败：' + ((e && e.message) || e) + ' —— ' + p.key;
                });
            return inst;
        },

        destroy(p) {
            const i = LIVE.findIndex((inst) => inst.p === p);
            if (i >= 0) { LIVE[i].aborted = true; LIVE.splice(i, 1); }
        },
    });
})();

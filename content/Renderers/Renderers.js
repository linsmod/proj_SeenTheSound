'use strict';

/* ============================================================
 * ChartRenderers —— 图表渲染器注册表（content/Renderers/，一个渲染器一个文件）
 *
 * 契约：renderer = { id, label, draw(ctx, view) }
 *   view 由页面打包（makeView）：{ w, h, out, ringMap, chartCount, rows, cols, colors, notes }
 *   渲染器只吃 view，不摸任何全局 —— 这是"组件化"的核心约束。
 *
 * 页面侧的职责（注册表不碰 DOC / 存档）：
 *   ChartRenderers.onChange = (ch, id) => { 持久化 + 重绘 }
 * ============================================================ */

(function () {
    const R = (window.ChartRenderers = window.ChartRenderers || {});

    R.defaultId = 'line';
    R.map = {};

    R.register = function (r) {
        if (!r || !r.id || typeof r.draw !== 'function') throw new Error('register: 渲染器需要 { id, label, draw }');
        R.map[r.id] = r;
    };
    R.get = function (id) { return R.map[id] || R.map[R.defaultId] || null; };
    R.ids = function () { return Object.keys(R.map); };
    R.next = function (id) {
        const ids = R.ids();
        const i = ids.indexOf(R.get(id).id);
        return ids[(i + 1) % ids.length];
    };

    // 切换：写回图表对象 → 通知页面（持久化 + 重绘是页面的职责）
    R.setOnChart = function (ch, id) {
        ch.render = R.get(id).id;
        if (typeof R.onChange === 'function') R.onChange(ch, ch.render);
    };

    // 播放按钮左边的模式切换钮：文案 = 当前渲染器，点击循环下一个
    R.makeModeButton = function (ch) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'pb';
        const sync = () => {
            const cur = R.get(ch.render);
            b.textContent = cur.label;
            b.title = '渲染方式：' + cur.label + '（点击切换为' + R.get(R.next(ch.render)).label + '）';
        };
        b.addEventListener('click', (ev) => { ev.stopPropagation(); R.setOnChart(ch, R.next(ch.render)); sync(); });
        sync();
        return b;
    };

    /* 共享底图：背景 + 横向网格 + 0/0.5/1 刻度。返回几何参数给渲染器继续画。 */
    R.drawFrame = function (ctx, v) {
        const W = v.w, H = v.h, padL = 14, padR = 4, padT = 5, padB = 12;
        const ih = H - padT - padB;
        ctx.fillStyle = '#0a1022';
        ctx.fillRect(0, 0, W, H);
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        for (let vv = 0; vv <= 1.001; vv += 0.25) {
            const y = Math.round(padT + ih * (1 - vv)) + 0.5;
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y);
            ctx.strokeStyle = (vv === 0 || vv === 1) ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
            ctx.lineWidth = 1; ctx.stroke();
            if (vv === 0 || vv === 0.5 || vv === 1) {
                ctx.fillStyle = 'rgba(114,134,173,0.65)';
                ctx.fillText(vv.toFixed(1), 2, y + 3);
            }
        }
        return { padL, padR, padT, padB, iw: W - padL - padR, ih };
    };
})();

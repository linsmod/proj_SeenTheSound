'use strict';

/* ============================================================
 * line —— 走势：窗口内 12 音级各一条时间线（默认渲染器）
 *
 * X 轴分辨率自适应：每个像素列装不下一个采样点时（窄画布），
 * 按列取 min/max 画竖向包络 —— 直连线会因欠采样丢峰，包络则如实保留。
 * 宽画布（每列 ≥1 个采样点）仍逐点连线。
 * ============================================================ */

(function () {
    const R = window.ChartRenderers;

    R.register({
        id: 'line',
        label: '走势',
        draw(ctx, v) {
            const geo = R.drawFrame(ctx, v);
            const padL = geo.padL, padR = geo.padR, padT = geo.padT, iw = geo.iw, ih = geo.ih;
            const yOf = (val) => padT + ih * (1 - Math.max(0, Math.min(1, val)));

            const cols = Math.max(1, Math.round(iw));
            const step = v.chartCount / cols;          // 每像素列平均装几个采样点
            const decimated = step > 1.5;
            const xOf = (p) => padL + iw * p / (v.cols - 1);

            for (let pc = 0; pc < v.rows; pc++) {
                const base = pc * v.cols, col = v.colors[pc];
                ctx.beginPath();
                if (decimated) {
                    for (let ci = 0; ci < cols; ci++) {
                        const p0 = Math.floor(ci * step), p1 = Math.min(v.chartCount, Math.floor((ci + 1) * step));
                        if (p1 <= p0) continue;
                        let mn = Infinity, mx = -Infinity;
                        for (let p = p0; p < p1; p++) { const val = v.out[base + v.ringMap[p]]; if (val < mn) mn = val; if (val > mx) mx = val; }
                        const x = padL + ci;           // 整数 x：列与像素对齐，逐帧不抖
                        ctx.moveTo(x, yOf(mn));
                        ctx.lineTo(x, yOf(mx));
                    }
                } else {
                    for (let p = 0; p < v.chartCount; p++) ctx.lineTo(xOf(p), yOf(v.out[base + v.ringMap[p]]));
                }
                ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.85)`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        },
    });
})();

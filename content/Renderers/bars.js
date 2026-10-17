'use strict';

/* ============================================================
 * bars —— 实时柱状：12 音级各一根柱，高度 = 窗口最新一帧的值。
 * 与走势互补：走势看"历史怎么变"，柱状看"此刻是什么形状"。
 * ============================================================ */

(function () {
    const R = window.ChartRenderers;

    R.register({
        id: 'bars',
        label: '柱状',
        draw(ctx, v) {
            const geo = R.drawFrame(ctx, v);
            const padL = geo.padL, padT = geo.padT, iw = geo.iw, ih = geo.ih;

            // 最新一帧：ringMap[chartCount-1]（预热期里就是已到的最后一帧）
            const p = Math.max(0, v.chartCount - 1);
            const idx = v.ringMap[p];
            const y0 = padT + ih;                              // 柱子基线
            const bw = Math.max(2, iw / v.rows * 0.62);        // 柱宽：留 38% 间隙

            ctx.font = '8px sans-serif';
            ctx.textAlign = 'center';
            for (let pc = 0; pc < v.rows; pc++) {
                const val = Math.max(0, Math.min(1, v.out[pc * v.cols + idx]));
                const x = padL + iw * (pc + 0.5) / v.rows;
                const y = padT + ih * (1 - val);
                const col = v.colors[pc];
                ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.85)`;
                ctx.fillRect(x - bw / 2, y, bw, y0 - y);
                if (v.notes && v.notes[pc]) {                  // 音名标在柱下，一眼对回音级
                    ctx.fillStyle = 'rgba(114,134,173,0.75)';
                    ctx.fillText(v.notes[pc], x, v.h - 2);
                }
            }
        },
    });
})();

'use strict';

/* ============================================================
 * sfm.matrix —— SFM 平坦度（写入时冻结）
 *
 * feed 逻辑原样搬自 dsp-lab 的 updateBuffers/freezeSfmDisp（Buffers 第 1 步：纯搬运，
 * 自检全绿 = 行为零变化的验收线）。
 *
 * 行为契约：第 idx 列的显示 SFM 按**当时的窗 K** 合成一次，此后历史值永不重算 ——
 * 旧的显示端滑窗在左边界截断（窗不满、随点左移变短 → 历史值被改写、左端变形），
 * 且老样本的槽位已被覆盖、无法补算，"写入时冻结"就是堵这个坑的。
 *
 * 私有状态：Σln / Σexp / 计数的三份环形累加器（与 ring 同布局，模块自管）。
 * ============================================================ */

(function () {
    const M = registerBuffer({
        id: 'sfm.matrix',
        label: 'SFM 平坦度',
        layout: { channels: 12, n: 250 },
        dtype: 'f32',
        range: [0, 1],
        unit: '平坦度（几何/算术均值比，1=纯音 0=白噪）',
        role: 'input',
        inputShape: 'vec12',
        note: '逐音级 SFM 统计量的滑窗合成；窗 K 由页面"平坦窗(秒)"控件给（env.winK）',

        writeColumn(idx, env) {
            const PC = M.channels, n = M.n;
            if (!SL || SL.length !== PC * n) { SL = new Float64Array(PC * n); SA = new Float64Array(PC * n); NN = new Float32Array(PC * n); }
            const K = Math.max(1, Math.min(n, env.winK | 0));
            for (let pc = 0; pc < PC; pc++) {
                const bins = (env.pcBins && env.pcBins[pc]) || [];
                let sl = 0, sa = 0, cnt = 0;
                for (let k = 0; k < bins.length; k++) {
                    const ln = env.freqData[bins[k]] * (env.span / 255) * (Math.LN10 / 20);
                    sl += ln; sa += Math.exp(ln); cnt++;
                }
                const o = pc * n + idx;
                SL[o] = sl; SA[o] = sa; NN[o] = cnt;
                // 冻结：这一列的显示值按当时的满窗 K 合成（历史槽位只读不改）
                let asl = 0, asa = 0, an = 0;
                for (let k = 0; k < K; k++) {
                    const oo = pc * n + ((idx - k + n) % n);
                    asl += SL[oo]; asa += SA[oo]; an += NN[oo];
                }
                M.buf[o] = an ? Math.exp(asl / an) / (asa / an) : 0;
            }
        },
    });

    let SL = null, SA = null, NN = null;   // 环形累加器（首列按布局分配）
})();

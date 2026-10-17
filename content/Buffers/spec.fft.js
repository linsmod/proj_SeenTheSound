'use strict';

/* ============================================================
 * spec.fft —— 频谱电平（按音级折叠）
 *
 * 原样搬自 dsp-lab updateBuffers 里的 spec 折叠段。与 sfm.matrix 共享页面的
 * pcBins 分拣口径（bin → 最近音 → 音级），所以三个 vec12 源逐列天然对齐。
 *
 * 值域语义：u8 频谱是 dBFS 的线性映射（-100..-30 dB → 0..255），均值/255 后
 * 0=静音、1=-30dBFS、满幅正弦饱和 —— 是**固定刻度**，不是归一化（要归一化在链里加 rescale）。
 * ============================================================ */

(function () {
    const M = registerBuffer({
        id: 'spec.fft',
        label: '频谱电平（音级折叠）',
        layout: { channels: 12, n: 250 },
        dtype: 'f32',
        range: [0, 1],
        unit: '电平（-100..-30 dBFS 线性映射，均值折叠）',
        role: 'input',
        inputShape: 'vec12',
        note: 'pcBins 内 u8 均值 / 255；弱 bin 会稀释强 bin（峰不突出），要峰值口径等 fold 算子',

        writeColumn(idx, env) {
            if (!env.pcBins) return;
            for (let pc = 0; pc < M.channels; pc++) {
                const bins = env.pcBins[pc];
                let m = 0;
                for (let k = 0; k < bins.length; k++) m += env.freqData[bins[k]];
                M.buf[pc * M.n + idx] = bins.length ? m / bins.length / 255 : 0;
            }
        },
    });
})();

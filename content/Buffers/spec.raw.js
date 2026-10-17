'use strict';

/* ============================================================
 * spec.raw —— 原始频谱（bin 级，未折叠）
 *
 * 随流的 u8 频谱直接进环（/255 线性刻度），**不做音级折叠** —— 折叠交给链里的
 * fold 算子（mode=mean/max 每图自选）。这是第一个变长源：
 *   · layout.channels = 4096 = FFT bin 上限（FFT_SIZE 8192 / 2）；CQT 模式只有几百 bin
 *   · 有效通道数 = 当前 bin 数（binLen()），runColumn 据此切 INPUT 的长度
 *   · 只写 [0, binLen) 段；bin 数变化时旧列的高段残留**不可达**（切片不读），无需清零
 *
 * role=input + inputShape='num[]'：InputSourcePicker 里可选（标注"变长"），
 * 但顶栏全局选择器不收（全局默认必须 vec12）——没有 fold 的链不要用它。
 * ============================================================ */

(function () {
    let binLen = 0;

    const M = registerBuffer({
        id: 'spec.raw',
        label: '原始频谱（未折叠）',
        layout: { channels: 4096, n: 250 },
        dtype: 'f32',
        range: [0, 1],
        unit: '电平（-100..-30 dBFS 线性映射）',
        role: 'input',
        inputShape: 'num[]',
        note: '有效通道 = 当前 bin 数（binLen()）；通道上限 4096 = FFT bin 上限，CQT 模式远低于此',

        binLen: () => binLen,

        writeColumn(idx, env) {
            if (!env.freqData) return;
            binLen = env.freqData.length;
            const n = M.n;
            for (let i = 0; i < binLen && i < M.channels; i++) {
                M.buf[i * n + idx] = env.freqData[i] / 255;
            }
        },
    });
})();

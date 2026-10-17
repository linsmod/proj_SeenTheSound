'use strict';

/* ============================================================
 * gate.grid —— 门控增益（9 音区 max）
 *
 * 两段式：onStream 解码随流的 u8 网格（9 音区 × 12 音级，行主序 z*12+pc），
 * writeColumn 在列节拍按音级取 9 音区最大值折成 12 通道 —— 任一音区被触发就算。
 *
 * --no-gate 启动时后端不下发 gate 字段 → gateSeen 恒 false → avail()=false，
 * 输入选择器里这项置灰；流里首次出现自动放开（页面监听 avail 翻转）。
 * ============================================================ */

(function () {
    let gateData = null, gateZones = 9, gateSeen = false;

    const M = registerBuffer({
        id: 'gate.grid',
        label: '门控增益（9 音区 max）',
        layout: { channels: 12, n: 250 },
        dtype: 'f32',
        range: [0, 1],
        unit: 'AHDSR 门控增益',
        role: 'input',
        inputShape: 'vec12',
        note: '后端 OnsetGate（--no-gate 关闭）；对同一音级取 9 音区最大值',

        avail: () => gateSeen,

        onStream(msg) {
            if (!msg.gate) return;
            const gb = atob(msg.gate);
            const zn = Math.floor(gb.length / 12);
            if (zn > 0 && zn * 12 === gb.length) {          // 长度不符（异常帧）不更新，保留旧值
                gateZones = zn;
                if (!gateData || gateData.length !== gb.length) gateData = new Uint8Array(gb.length);
                for (let i = 0; i < gb.length; i++) gateData[i] = gb.charCodeAt(i);
                gateSeen = true;
            }
        },

        writeColumn(idx, env) {
            for (let pc = 0; pc < 12; pc++) {
                let g = 0;
                for (let z = 0; z < gateZones; z++) {
                    const v = gateData ? gateData[z * 12 + pc] : 0;
                    if (v > g) g = v;
                }
                M.buf[pc * M.n + idx] = g / 255;
            }
        },
    });
})();

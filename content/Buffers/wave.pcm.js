'use strict';

/* ============================================================
 * wave.pcm —— 原始波形（峰保持抽取）
 *
 * 单通道、自管缓冲：随流增量段（f32 LE，fs/2000 ≈ 2kHz 有符号峰）按 wHz
 * 拼进 2 秒环。不占列节拍（msg 频率 ≈ 30fps，段长随帧变化），所以没有
 * writeColumn —— layout 也不声明，注册表不给它分配 buf，全在 M.ring。
 *
 * role='aux' + inputShape 缺省 → Buffers.inputs() 自动排除：单通道喂不进
 * 12 通道的链，它存着是给将来的波形显示视图用的。
 * ============================================================ */

(function () {
    const M = registerBuffer({
        id: 'wave.pcm',
        label: '原始波形（峰保持抽取）',
        dtype: 'f32',
        range: [-1, 1],
        unit: '相对满幅（0dBFS=1）',
        role: 'aux',
        note: '仅显示用；ring 挂在 M.ring（容量 wHz×2 秒），M.w 是写游标',

        onStream(msg) {
            if (!msg.w || !msg.wHz) return;
            if (!M.ring || M.hz !== msg.wHz) {   // 抽取率变了（换采样设备）→ 重建环
                M.hz = msg.wHz;
                M.ring = new Float32Array(Math.round(M.hz * 2));
                M.w = 0;
            }
            const wb = atob(msg.w);
            const u8 = new Uint8Array(wb.length);
            for (let i = 0; i < wb.length; i++) u8[i] = wb.charCodeAt(i);
            const dv = new DataView(u8.buffer);
            const cnt = Math.floor(wb.length / 4);
            for (let i = 0; i < cnt; i++) {
                M.ring[M.w] = dv.getFloat32(i * 4, true);
                M.w = (M.w + 1) % M.ring.length;
            }
        },
    });
})();

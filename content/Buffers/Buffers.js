'use strict';

/* ============================================================
 * Buffers —— 数据面缓冲注册表（content/Buffers/，一个缓冲一个文件）
 *
 * 与 Functions / UIControls 同一套玩法：页面 <script> 逐个载入，
 * 各文件 registerBuffer({...}) 把自己挂进注册表；currentScript 记来源归属。
 *
 * 契约：
 *   id            唯一名（与 /api/sources 的 id 对齐，如 'sfm.matrix'）
 *   label         选择器 / 元数据视图显示名
 *   layout        可选 { channels, n }；给了就分配 mod.buf（Float32Array, 通道主序 pc*n+idx）。
 *                 不给 = 自管缓冲（如 wave.pcm 的变长环）
 *   dtype/range/unit   元数据（fnview 展示）
 *   role          'input' = 可当链输入（还需 inputShape 才进选择器）| 'aux' = 仅存储
 *   inputShape    'vec12' | 'pcm' | null —— vec12 才会被 Buffers.inputs() 收进
 *   writeColumn(idx, env)   tick 缓冲必须：页面的列节拍（50Hz）对每列调一次，
 *                         从 env（freqData/pcBins/span/winK…）折叠/合成写入自己的第 idx 列
 *   onStream(msg, env)      可选：消费随流原始字段（解码/置可用性），每条 SSE 消息分发一次
 *   avail()                 可选：返回 false 时输入选择器置灰（如 --no-gate 的 gate.grid）
 *
 * 页面保留的东西（故意不下放）：
 *   · 列节拍 chartWrite/chartSeq —— 多缓冲必须逐列对齐，自检的环形映射全押在这上面
 *   · 频谱解码（msg.s → freqData）与 pcBins 分拣 —— 多缓冲共享同一口径
 * ============================================================ */

(function () {
    const Buffers = (window.Buffers = window.Buffers || {});
    const REG = new Map();

    // 裸全局调用（与 Functions 的 registerFunction 同款惯例）：缓冲模块里直接 registerBuffer({...})
    window.registerBuffer = function (mod) { return Buffers.registerBuffer(mod); };

    Buffers.registerBuffer = function (mod) {
        if (!mod || !mod.id) throw new Error('registerBuffer: 模块缺少 id');
        try {
            const cs = document.currentScript;
            mod.srcFile = mod.srcFile || ((cs && cs.src) ? cs.src.split('/').pop() : '');
        } catch (e) { mod.srcFile = mod.srcFile || ''; }
        if (mod.layout) {
            mod.channels = mod.layout.channels | 0;
            mod.n = mod.layout.n | 0;
            mod.buf = new Float32Array(mod.channels * mod.n);   // 通道主序：pc*n + idx
        }
        if (REG.has(mod.id)) console.warn('[Buffers] 覆盖注册同名缓冲: ' + mod.id);
        REG.set(mod.id, mod);
        return mod;
    };

    Buffers.get = (id) => REG.get(id) || null;
    Buffers.all = () => Array.from(REG.values());
    // 可当链输入的：role=input 且声明 vec12（wave.pcm 的 pcm 自动出局）
    Buffers.inputs = () => Buffers.all().filter((b) => b.role === 'input' && b.inputShape === 'vec12');
    // 列节拍：tick 缓冲逐个写新列。顺序 = 注册顺序，同一列内各缓冲看到同一个 env
    Buffers.writeColumn = function (idx, env) {
        for (const b of REG.values()) if (b.writeColumn) b.writeColumn(idx, env);
    };
    // 随流：声明了 onStream 的缓冲各自消费原始字段
    Buffers.onMessage = function (msg, env) {
        for (const b of REG.values()) if (b.onStream) b.onStream(msg, env);
    };
})();

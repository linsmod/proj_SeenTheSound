'use strict';

/* ============================================================
 * bufview —— 缓冲机制视图（树里点「Buffers 数据面」目录打开）
 *
 * 一屏讲清数据面的四件事：
 *   1. 流水线：SSE → 解码/分拣 → 各缓冲（折叠口径不同）→ 输入选择 → 链
 *   2. 环形推进：每块 vec12 环一张圆环图，写头（chartWrite）随节拍前进
 *   3. 写入时冻结：sfm 的窗 K 扇区淡高亮（合成只发生在写入那刻）
 *   4. 数据长相：12×250 热图（行=音级用图例配色、列=时间、色=值），三源并排=逐列对齐可见
 *   wave.pcm 单通道自管环：线性条带 + 写游标
 *
 * 数据全部现读 Buffers 注册表 + 页面 env（window.dspEnv：chartWrite/ringMap 常量）。
 * 不经 DSPRun、不改任何状态 —— 纯只读仪表。
 * ============================================================ */

(function () {
    const LIVE = [];   // 已挂载实例

    Views.registerView({
        id: 'bufview',

        mount(p) {
            const env = window.dspEnv || null;
            const host = p.el;
            host.textContent = '';
            const inst = { p, parts: [], wave: null };

            const head = document.createElement('div');
            head.className = 'st';
            head.textContent = env
                ? '数据面机制：写头随节拍推进，各缓冲按自己的口径写入同一列'
                : '页面环境（dspEnv）未就绪 —— 无法显示实时写头';
            host.appendChild(head);

            host.appendChild(pipelineSvg());

            const grid = document.createElement('div');
            grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;';
            host.appendChild(grid);

            for (const b of (window.Buffers ? Buffers.inputs() : [])) {
                const block = document.createElement('div');
                block.style.cssText = 'flex:1 1 320px;min-width:300px;';
                const cap = document.createElement('div');
                cap.className = 'st';
                cap.textContent = `${b.label} · 写头 --`;
                block.appendChild(cap);
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:10px;align-items:center;';
                const ringCv = mkCanvas(170, 170);
                const heatCv = mkCanvas(env ? env.CHART_N * 1.5 : 375, 12 * 8);
                row.append(ringCv, heatCv);
                block.appendChild(row);
                const hint = document.createElement('div');
                hint.className = 'tpl-empty';
                hint.textContent = heatHint();
                block.appendChild(hint);
                grid.appendChild(block);
                inst.parts.push({ b, ringCv, heatCv, cap });
            }

            const wave = window.Buffers ? Buffers.get('wave.pcm') : null;
            if (wave) {
                const block = document.createElement('div');
                block.style.marginTop = '12px';
                const cap = document.createElement('div');
                cap.className = 'st';
                cap.textContent = `${wave.label} · 自管环（旁路存储，不占列节拍）`;
                block.appendChild(cap);
                const strip = mkCanvas(620, 70);
                block.appendChild(strip);
                host.appendChild(block);
                inst.wave = { b: wave, cv: strip };
            }

            const foot = document.createElement('div');
            foot.className = 'tpl-empty';
            foot.textContent = '环上亮标 = 写头（chartWrite）；扇区 = sfm 的冻结窗 K（合成只发生在写入那刻）。'
                + '热图行=音级（配色同图例），列=时间（右=最新）；三块热图滚动完全同步 = 多源逐列对齐。';
            host.appendChild(foot);

            LIVE.push(inst);
            return inst;
        },

        tick() {
            for (const inst of LIVE) {
                const el = inst.p.el;
                if (!el || el.hidden || !el.isConnected) continue;   // 隐藏/离树不画
                const env = window.dspEnv;
                if (!env || !window.Buffers) continue;
                for (const part of inst.parts) drawRing(part, env);
                for (const part of inst.parts) drawHeat(part, env);
                if (inst.wave) drawWave(inst.wave);
            }
        },

        destroy(p) {
            const i = LIVE.findIndex((inst) => inst.p === p);
            if (i >= 0) LIVE.splice(i, 1);
        },
    });

    /* ---------- 画法 ---------- */

    function drawRing(part, env) {
        const { b, ringCv, cap } = part;
        const ctx = ringCv.getContext('2d');
        const W = ringCv._w, H = ringCv._h, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 10;
        ctx.clearRect(0, 0, W, H);
        if (!b.buf) return;
        const n = b.n, cw = (Math.PI * 2) / n;
        const a0 = -Math.PI / 2;                       // 列 0 在正上方
        for (let i = 0; i < n; i++) {
            let v = 0;
            for (let pc = 0; pc < b.channels; pc++) v += b.buf[pc * n + i];
            v /= b.channels;
            ctx.beginPath();
            ctx.arc(cx, cy, R, a0 + i * cw + 0.004, a0 + (i + 1) * cw - 0.004);
            ctx.strokeStyle = `rgba(74,224,255,${(0.08 + 0.85 * v).toFixed(3)})`;
            ctx.lineWidth = 7;
            ctx.stroke();
        }
        // sfm 的冻结窗 K 扇区：写头往回 K 格的淡高亮（其余缓冲没有这个语义）
        if (b.id === 'sfm.matrix') {
            const K = Math.max(1, Math.min(n, env.winK | 0));
            ctx.beginPath();
            ctx.arc(cx, cy, R, a0 + (env.chartWrite() - K + n) * cw, a0 + env.chartWrite() * cw);
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 7;
            ctx.stroke();
        }
        // 写头
        const wi = env.chartWrite();
        const wx = cx + Math.cos(a0 + wi * cw) * R, wy = cy + Math.sin(a0 + wi * cw) * R;
        ctx.beginPath();
        ctx.arc(wx, wy, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        cap.textContent = `${b.label} · 写头 ${wi} / seq ${env.chartSeq()}`;
    }

    function drawHeat(part, env) {
        const { b, heatCv } = part;
        const ctx = heatCv.getContext('2d');
        const W = heatCv._w, H = heatCv._h;
        ctx.clearRect(0, 0, W, H);
        if (!b.buf) return;
        const n = b.n, cw = W / n, rh = H / b.channels;
        const rgb = env.SEMI_RGB;
        for (let p = 0; p < n; p++) {
            const i = (env.chartWrite() + p) % n;      // 窗口序：右端 = 最新
            for (let pc = 0; pc < b.channels; pc++) {
                const v = Math.max(0, Math.min(1, b.buf[pc * n + i]));
                const c = rgb[pc];
                ctx.fillStyle = `rgba(${(c[0] * (0.12 + 0.88 * v)) | 0},${(c[1] * (0.12 + 0.88 * v)) | 0},${(c[2] * (0.12 + 0.88 * v)) | 0},1)`;
                ctx.fillRect(p * cw, pc * rh, Math.ceil(cw), Math.ceil(rh) - 1);
            }
        }
        // 写头位置（右端 = 刚写过；窗口序下写头紧跟最新列左侧一格——不画线，避免误读）
        heatCv.title = '行=音级（C 在顶，配色同图例）· 列=时间（右=最新）· 色=缓冲当前值';
    }

    function drawWave(w) {
        const ctx = w.cv.getContext('2d');
        const W = w.cv._w, H = w.cv._h;
        ctx.clearRect(0, 0, W, H);
        const b = w.b;
        if (!b.ring || !b.ring.length) return;
        const n = b.ring.length;
        ctx.strokeStyle = 'rgba(74,224,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const idx = (b.w + i) % n;                 // 游标处最旧 → 绕一圈到最新
            const x = (i / (n - 1)) * W;
            const y = H / 2 - Math.max(-1, Math.min(1, b.ring[idx])) * (H / 2 - 4);
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
        const wx = (W * n) / n;                        // 游标 = 环的最右端（最新样本之后）
        ctx.fillStyle = '#fff';
        ctx.fillRect(W - 2, 0, 2, H);
        void wx;
    }

    /* ---------- 骨架 ---------- */

    function mkCanvas(w, h) {
        const cv = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        cv.width = w * dpr; cv.height = h * dpr;
        cv.style.width = w + 'px'; cv.style.height = h + 'px';
        cv.getContext('2d').scale(dpr, dpr);
        cv._w = w; cv._h = h;
        return cv;
    }

    function heatHint() {
        return '左：环（250 列首尾相接，亮标=写头）　右：内容热图（行=音级，列=时间，右=最新）';
    }

    function pipelineSvg() {
        const wrap = document.createElement('div');
        wrap.innerHTML = `
<svg viewBox="0 0 760 150" style="width:100%;max-width:780px;height:auto;font-size:11px;">
  <defs>
    <marker id="bv-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#5a6c94"/>
    </marker>
  </defs>
  <g fill="none" stroke="#5a6c94" stroke-width="1.2" marker-end="url(#bv-arrow)">
    <path id="bv-e1" d="M96,75 H150"/>
    <path id="bv-e2" d="M252,75 H320"/>
    <path id="bv-e3" d="M420,52 H470"/>
    <path id="bv-e4" d="M420,75 H470"/>
    <path id="bv-e5" d="M420,98 H470"/>
    <path id="bv-e6" d="M600,52 H660 V68 H690"/>
    <path id="bv-e7" d="M600,75 H690"/>
    <path id="bv-e8" d="M600,98 H660 V82 H690"/>
  </g>
  <g font-family="Segoe UI, sans-serif" fill="#8fa2c8">
    <rect x="16" y="58" width="80" height="34" rx="6" fill="#0e1630" stroke="rgba(255,255,255,0.2)"/>
    <text x="56" y="79" text-anchor="middle">SSE /stream</text>
    <rect x="150" y="58" width="102" height="34" rx="6" fill="#0e1630" stroke="rgba(255,255,255,0.2)"/>
    <text x="201" y="73" text-anchor="middle">频谱解码</text>
    <text x="201" y="86" text-anchor="middle" fill="#5a6c94">u8 → freqData</text>
    <rect x="320" y="58" width="100" height="34" rx="6" fill="#0e1630" stroke="rgba(255,255,255,0.2)"/>
    <text x="370" y="73" text-anchor="middle">pcBins 分拣</text>
    <text x="370" y="86" text-anchor="middle" fill="#5a6c94">bin → 音级</text>
    <rect x="470" y="38" width="130" height="28" rx="6" fill="#0e1630" stroke="rgba(74,224,255,0.4)"/>
    <text x="535" y="56" text-anchor="middle">sfm.matrix（冻结）</text>
    <rect x="470" y="61" width="130" height="28" rx="6" fill="#0e1630" stroke="rgba(74,224,255,0.4)"/>
    <text x="535" y="79" text-anchor="middle">spec.fft（均值折叠）</text>
    <rect x="470" y="84" width="130" height="28" rx="6" fill="#0e1630" stroke="rgba(74,224,255,0.4)"/>
    <text x="535" y="102" text-anchor="middle">gate.grid（max 折叠）</text>
    <rect x="690" y="58" width="60" height="34" rx="6" fill="#0e1630" stroke="rgba(74,224,255,0.45)"/>
    <text x="720" y="79" text-anchor="middle">链 INPUT</text>
    <rect x="180" y="118" width="240" height="26" rx="6" fill="#0a1022" stroke="rgba(255,255,255,0.14)"/>
    <text x="300" y="135" text-anchor="middle" fill="#5a6c94">msg.w → wave.pcm（旁路：自管环，仅显示用）</text>
    <text x="380" y="24" text-anchor="middle" fill="#5a6c94">三块缓冲同一列节拍（chartWrite / chartSeq），逐列对齐</text>
  </g>
</svg>`;
        return wrap;
    }
})();

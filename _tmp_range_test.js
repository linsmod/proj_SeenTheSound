// 一次性验证：反平坦度曲线（极差·重缩放）（跑完即删）
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/\/\/ ---------- 反平坦度曲线（极差[\s\S]*?(?=    \/\/ ---------- 音级平坦度差值)/);
if (!m) { console.error('EXTRACT FAIL'); process.exit(1); }

const CHART_N = 250, SFM_CH = 13;
let chartCount = 250;
const sfmLines = new Float32Array(SFM_CH * CHART_N);
const SEMI_RGB = Array.from({ length: 12 }, (_, i) => [i + 1, i + 2, i + 3]);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const strokes = [];
let cur = null;
const fakeCtx = {
    font: '', textAlign: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    clearRect() {}, fillRect() {}, setTransform() {}, fillText() {},
    beginPath() { cur = { lines: [] }; },
    moveTo() {},
    lineTo(x, y) { cur.lines.push([x, y]); },
    stroke() { strokes.push(cur); cur = null; },
};
const fakeCanvas = { width: 376, height: 120, getContext: () => fakeCtx };
global.document = { getElementById: () => fakeCanvas };
global.window = { devicePixelRatio: 1 };

const api = eval(m[0] + '\n;({ drawSfmRange, fitSfmRange })');

let fails = 0;
const near = (a, b, t = 1e-2) => Math.abs(a - b) <= t;
const yTop = 6, yBot = 6 + 101, yMidFlat = 6 + 101 * 0.5;
const curve = (i) => strokes[5 + i];   // strokes[0..4]=网格

// 数据：pc0 反相 0.8→0.4 递减，pc2 反相 0.25→0.65 递增（两端极值交替），pc1/其余恒 0.1
for (let p = 0; p < chartCount; p++) {
    const t = p / (chartCount - 1);
    sfmLines[1 * CHART_N + p] = 0.2 + t * 0.4;          // pc0 原始 0.2~0.6 → 反相 0.8~0.4
    sfmLines[3 * CHART_N + p] = 0.75 - t * 0.4;         // pc2 原始 0.75~0.35 → 反相 0.25~0.65
    for (let pc = 0; pc < 12; pc++) if (pc !== 0 && pc !== 2) sfmLines[(1 + pc) * CHART_N + p] = 0.9;
}

strokes.length = 0;
api.drawSfmRange();
if (strokes.length !== 17) { fails++; console.log('FAIL strokes=' + strokes.length); }
// 贴边不变性：每个采样点都有曲线在顶（y=6）且有曲线在底（y=107）
outer:
for (let p = 0; p < chartCount; p++) {
    let hi = Infinity, lo = -Infinity;
    for (let pc = 0; pc < 12; pc++) {
        const y = curve(pc).lines[p][1];
        if (y < hi) hi = y;
        if (y > lo) lo = y;
    }
    if (!near(hi, yTop) || !near(lo, yBot)) { fails++; console.log(`FAIL 丝带未贴边 p=${p} hi=${hi} lo=${lo}`); break outer; }
}
// 极值交替：p=0 时 pc0 贴顶、pc2 y≈85.4；p=末 时 pc2 贴顶、pc0 y≈51.9；恒低音级贴底
if (!near(curve(0).lines[0][1], yTop)) { fails++; console.log('FAIL p0 pc0 y=' + curve(0).lines[0][1]); }
if (!near(curve(2).lines[0][1], 6 + 101 * (1 - (0.25 - 0.1) / 0.7))) { fails++; console.log('FAIL p0 pc2 y=' + curve(2).lines[0][1]); }
if (!near(curve(2).lines[chartCount - 1][1], yTop)) { fails++; console.log('FAIL pLast pc2 y=' + curve(2).lines[chartCount - 1][1]); }
if (!near(curve(0).lines[chartCount - 1][1], 6 + 101 * (1 - (0.4 - 0.1) / 0.55))) { fails++; console.log('FAIL pLast pc0 y=' + curve(0).lines[chartCount - 1][1]); }
if (!near(curve(1).lines[100][1], yBot)) { fails++; console.log('FAIL pc1 y=' + curve(1).lines[100][1]); }

// 全部同值（极差0）→ 居中 0.5
sfmLines.fill(0.5);
strokes.length = 0;
api.drawSfmRange();
for (let pc = 0; pc < 12; pc++)
    for (const [, y] of curve(pc).lines) if (!near(y, yMidFlat)) { fails++; console.log('FAIL flat y=' + y); break; }

if (fails === 0) { console.log('PASS: 每采样点丝带贴边、极值交替正确、极差0居中'); process.exit(0); }
console.log('FAIL: ' + fails + ' 处'); process.exit(1);
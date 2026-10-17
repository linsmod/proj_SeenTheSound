'use strict';

/* ============================================================
 * 重构等价性对照：旧实现（dsp-lab.html 的 OPS + computeChart）
 *                 vs 新运行时（Processor.js + Compile.js + Ops.js）
 *
 * 做法：
 *   1. 从 dsp-lab.html 里把 `const OPS = {...}` 与 `function computeChart(...)` 原文抠出来，
 *      在 vm 里原样跑 —— 对比的是**真的旧代码**，不是凭记忆重写的近似物。
 *   2. 造一份确定性的 sfmLines（12 × 250，Float32Array，和线上同一个容器类型）。
 *   3. 旧：整窗 250 帧一次算完；新：逐帧 DSPRun 推进 250 次。
 *   4. 逐点比对（都按末端同样的 clamp(0,1) + Math.fround 落盘）。
 *
 * 运行： node content/Functions/_equiv.js
 * ============================================================ */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../..');
const PC = 12;
const N = 250;

/* ---------- 1. 载入新运行时 ---------- */
function loadRuntime() {
  // 先运行时与编译器，再自动载入目录下所有模块（文件名不以 _ 开头）——
  // 以后新增一个函数文件不用回来改这里。
  const core = ['Processor.js', 'Compile.js'];
  for (const f of core) vm.runInThisContext(fs.readFileSync(path.join(HERE, f), 'utf8'), { filename: f });
  const mods = fs.readdirSync(HERE)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_') && core.indexOf(f) < 0)
    .sort();
  for (const f of mods) vm.runInThisContext(fs.readFileSync(path.join(HERE, f), 'utf8'), { filename: f });

  if (typeof DSPRun !== 'function') throw new Error('Processor.js 没载入成功');
  if (typeof compileChart !== 'function') throw new Error('Compile.js 没载入成功');
  if (!getFunction('zscore')) throw new Error('zscore 没注册成功');
  global.__modules = mods;
}

/* ---------- 2. 从 dsp-lab.html 抠出旧实现 ---------- */
function sliceBlock(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error('找不到片段: ' + marker);
  // marker 自带结尾的 {，直接用它当起点；否则往后找一个
  let j = i + marker.length - 1;
  if (text[j] !== '{') j = text.indexOf('{', j);
  if (j < 0) throw new Error('片段没有 { : ' + marker);
  let depth = 0;
  for (let k = j; k < text.length; k++) {
    const c = text[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(i, k + 1);
    }
  }
  throw new Error('括号不配对: ' + marker);
}

function loadLegacy() {
  const html = fs.readFileSync(path.join(ROOT, 'dsp-lab.html'), 'utf8');
  const opsText = sliceBlock(html, 'const OPS = {');
  const cmpText = sliceBlock(html, 'function computeChart(ch, sfmLines) {');
  const code = [
    `var SFM_PC = ${PC}, CHART_N = ${N}, chartCount = ${N};`,
    `var pipeTmp = new Float64Array(SFM_PC), rankTmp = new Float64Array(SFM_PC);`,
    opsText,
    cmpText,
    'globalThis.__legacy = { OPS, computeChart };',
  ].join('\n');
  vm.runInThisContext(code, { filename: 'legacy-from-html.js' });
  return globalThis.__legacy;
}

/* ---------- 3. 确定性输入 ---------- */
function makeSfmLines() {
  const a = new Float32Array(PC * N);
  let s = 20241105;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let pc = 0; pc < PC; pc++) {
    for (let p = 0; p < N; p++) {
      // 量化到 0.05 一档：制造一些并列值，专门压测 rank 的平均秩分支
      a[pc * N + p] = Math.round(rnd() * 20) / 20 * (0.85 + 0.15 * Math.sin((p + pc) / 7));
      if (rnd() < 0.03) a[pc * N + p] = 0;      // 少量 0：压测 log 的 max(0,x)
    }
  }
  return a;
}

/* ---------- 4. 跑一遍 ---------- */
function runLegacy(legacy, stages, sfmLines) {
  const ch = { out: new Float32Array(PC * N), stages };
  legacy.computeChart(ch, sfmLines);
  return ch.out;
}

function runNew(stages, sfmLines) {
  const proc = compileChart({ stages }, 'equiv', { tapCap: 0 });
  const st = createFrameState({ now: (() => { let t = 0; return () => ++t; })() });
  st.DSP_ARR = [proc];
  const out = new Float32Array(PC * N);          // 与旧实现同一个落盘容器
  for (let p = 0; p < N; p++) {
    const inp = new Float64Array(PC);            // 旧实现内部工作区是 Float64，保持一致
    for (let pc = 0; pc < PC; pc++) inp[pc] = sfmLines[pc * N + p];
    st.INPUT = inp;
    const r = DSPRun(st);
    for (let pc = 0; pc < PC; pc++) out[pc * N + p] = Math.max(0, Math.min(1, r[pc]));
    if (st.ERROR) throw new Error(`帧 ${p} 出错: ${st.ERROR.key} ${st.ERROR.msg}`);
  }
  if (proc.warnings.length) throw new Error('编译告警: ' + proc.warnings.join('; '));
  return out;
}

function compare(name, a, b) {
  let bad = 0, maxd = 0, first = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxd) maxd = d;
    if (a[i] !== b[i]) { bad++; if (first < 0) first = i; }
  }
  const tag = bad === 0 ? 'OK  ' : 'DIFF';
  console.log(`[${tag}] ${name.padEnd(26)} 点=${a.length} 不一致=${bad} 最大差=${maxd.toExponential(2)}` +
    (first >= 0 ? ` 首个@${first}(pc=${Math.floor(first / N)},p=${first % N}) 旧=${a[first]} 新=${b[first]}` : ''));
  return bad;
}

/* ---------- main ---------- */
loadRuntime();
const legacy = loadLegacy();
const sfmLines = makeSfmLines();

const dir = path.join(ROOT, 'content/Templates');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '$schema.json').sort();

let total = 0, badTotal = 0;
for (const f of files) {
  const card = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!Array.isArray(card.stages)) continue;
  const stages = card.stages.map((s) => ({ id: s.id, on: s.on !== false, p: s.p || {} }));

  const a = runLegacy(legacy, stages, sfmLines);
  const b = runNew(stages, sfmLines);
  total++;
  badTotal += compare(f, a, b);
}

// 额外压测：停用某一级（旧实现跳过 / 新实现旁路，必须一致）
for (const f of ['inv+zscore.json', 'inv+rank.json', 'inv+log+rescale.json']) {
  const fp = path.join(dir, f);
  if (!fs.existsSync(fp)) continue;
  const card = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (!Array.isArray(card.stages) || !card.stages.length) continue;
  const stages = card.stages.map((s) => ({ id: s.id, on: s.on !== false, p: s.p || {} }));
  stages[0].on = false;
  const a = runLegacy(legacy, stages, sfmLines);
  const b = runNew(stages, sfmLines);
  total++;
  badTotal += compare(f + '（首级停用）', a, b);
}

console.log(`\n合计 ${total} 组，不一致 ${badTotal} 点。`);
process.exit(badTotal === 0 ? 0 : 1);

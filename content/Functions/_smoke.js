'use strict';

/* ============================================================
 * 底层能力自测：端口 / 寄存器 / 可重入子链 / 跳转 / 错误隔离 / 形状校验
 * 运行： node content/Functions/_smoke.js
 * ============================================================ */

const fs_ = require('fs');
const vm = require('vm');
const path = require('path');

const HERE = __dirname;
// 运行时 + 编译器先上，再自动载入目录下所有模块（文件名不以 _ 开头）
for (const f of ['Processor.js', 'Compile.js']) {
  vm.runInThisContext(fs_.readFileSync(path.join(HERE, f), 'utf8'), { filename: f });
}
for (const f of fs_.readdirSync(HERE).filter((x) => x.endsWith('.js') && !x.startsWith('_')).sort()) {
  if (f === 'Processor.js' || f === 'Compile.js') continue;
  vm.runInThisContext(fs_.readFileSync(path.join(HERE, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra === undefined ? '' : '  → ' + JSON.stringify(extra)}`); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function mkFS() { return createFrameState({ now: (() => { let t = 0; return () => ++t; })() }); }
function runChain(insts, input, opts) {
  const st = mkFS();
  st.DSP_ARR = [compileProcessor(insts, 'test', opts)];
  st.INPUT = input;
  return { out: DSPRun(st), st, proc: st.DSP_ARR[0] };
}

/* ---------- 1. TopK：返回值 + 端口 ---------- */
console.log('TopK / 端口');
{
  const r = runChain(
    [{ mod: getFunction('TopK'), inst: { args: { K: 3 }, wired: { dupOut: true, dupRest: true }, switches: { dupOut: true, dupRest: true } } }],
    Float64Array.from([0.1, 0.9, 0.4, 0.7, 0.2]),
  );
  const b = r.proc.instances[0];
  ok('top3 正确', eq(Array.from(r.out), [0.9, 0.7, 0.4]), Array.from(r.out));
  ok('端口 dupOut 收到前 k', eq(Array.from(b.ports.dupOut.value), [0.9, 0.7, 0.4]));
  ok('端口 dupRest 收到剩余', eq(Array.from(b.ports.dupRest.value), [0.2, 0.1]));
  ok('端口描述符没被数据覆盖', b.ports.dupOut.wired === true && b.ports.dupOut.pin === 'dsppin-S1');

  // 连跑两帧：端口状态不该被重置（functions 是稳定数组，不是每帧重新绑定）
  r.st.INPUT = Float64Array.from([1, 2, 3]);
  DSPRun(r.st);
  ok('第二帧端口仍然有效', eq(Array.from(b.ports.dupOut.value), [3, 2, 1]), b.ports.dupOut.value && Array.from(b.ports.dupOut.value));

  // 未接线 → 不写
  const r2 = runChain([{ mod: getFunction('TopK'), inst: { args: { K: 1 } } }], Float64Array.from([5, 6]));
  ok('未接线的端口不写入', r2.proc.instances[0].ports.dupOut.value === undefined);

  // K 缺省
  const r3 = runChain([{ mod: getFunction('TopK'), inst: {} }], Float64Array.from(Array.from({ length: 20 }, (_, i) => i)));
  ok('K 缺省 = 10', r3.out.length === 10, r3.out.length);
}

/* ---------- 2. 寄存器：跨级接线 ---------- */
console.log('寄存器 / 接线');
{
  registerFunction({
    id: 'W', kind: 'plain', io: { in: 'num[]', out: 'num[]' },
    f: (fs) => { fs.write('mid', fs.INPUT.reduce((a, b) => a + b, 0)); return fs.INPUT; },
  });
  registerFunction({
    id: 'R', kind: 'plain', io: { in: 'num[]', out: 'scalar' },
    f: (fs) => fs.read('mid') * 2,
  });
  const r = runChain([{ mod: getFunction('W') }, { mod: getFunction('R') }], Float64Array.from([1, 2, 3]));
  ok('write → read 跨级取到 6*2', r.out === 12, r.out);
}

/* ---------- 3. 可重入：子链嵌套，且不破坏外层索引 ---------- */
console.log('可重入 fs.run');
{
  const sub = [{ functions: () => [(fs) => fs.INPUT * 2] }];
  registerFunction({
    id: 'MapEach', kind: 'plain', io: { in: 'num[]', out: 'num[]' },
    f: (fs) => Array.from(fs.INPUT, (x) => fs.run(fs.FS_ARGS.sub, x)),
  });
  registerFunction({
    id: 'Plus1', kind: 'plain', io: { in: 'num[]', out: 'num[]' },
    f: (fs) => Array.from(fs.INPUT, (x) => x + 1),
  });
  registerFunction({
    id: 'Times10', kind: 'plain', io: { in: 'num[]', out: 'num[]' },
    f: (fs) => Array.from(fs.INPUT, (x) => x * 10),
  });
  const r = runChain(
    [{ mod: getFunction('MapEach'), inst: { args: { sub } } }, { mod: getFunction('Plus1') }, { mod: getFunction('Times10') }],
    Float64Array.from([1, 2, 3]),
  );
  // (x*2 + 1) * 10 —— 若子链把外层 FN_IDX 弄乱，第三级就不会执行
  ok('嵌套后外层链继续跑', eq(Array.from(r.out), [30, 50, 70]), Array.from(r.out));
  ok('嵌套不污染外层 fs.INPUT', r.st.INPUT instanceof Float64Array);
}

/* ---------- 4. 跳转：JNZ 优先级已修正 ---------- */
console.log('跳转');
{
  const log = [];
  const st = mkFS();
  st.INPUT = 0;
  st.DSP_ARR = [{
    functions: () => [
      (fs) => { log.push('a'); fs.FN_JNZ = () => false; fs.FN_JMP = 2; return 1; },
      (fs) => { log.push('b'); return 2; },
      (fs) => { log.push('c'); return 3; },
    ],
  }];
  DSPRun(st);
  ok('条件为假时 JMP 不再被无条件采纳', eq(log, ['a', 'b', 'c']), log);

  const log2 = [];
  const st2 = mkFS();
  st2.INPUT = 0;
  st2.DSP_ARR = [{
    functions: () => [
      (fs) => { log2.push('a'); fs.JUMP_IF(() => true, 2); return 1; },
      (fs) => { log2.push('b'); return 2; },
      (fs) => { log2.push('c'); return 3; },
    ],
  }];
  DSPRun(st2);
  ok('条件为真时跳过中间级', eq(log2, ['a', 'c']), log2);

  let threw = false;
  const st3 = mkFS();
  st3.INPUT = 0;
  st3.DSP_ARR = [{ functions: () => [(fs) => { fs.JUMP(99); return 1; }] }];
  try { DSPRun(st3); } catch (e) { threw = /越界/.test(e.message); }
  ok('越界跳转直接报错（不再静默吞掉）', threw);
}

/* ---------- 5. 错误隔离 / 形状校验 ---------- */
console.log('错误隔离');
{
  registerFunction({
    id: 'Boom', kind: 'plain', io: { in: 'any', out: 'any' },
    f: () => { throw new Error('炸了'); },
  });
  registerFunction({
    id: 'BadShape', kind: 'plain', io: { in: 'any', out: 'vec12' },
    f: () => [1, 2, 3],
  });
  registerFunction({ id: 'Identity', kind: 'plain', io: { in: 'any', out: 'any' }, f: (fs) => fs.INPUT });

  const r = runChain([{ mod: getFunction('Boom') }, { mod: getFunction('Identity') }], Float64Array.from([7, 8]));
  ok('抛错的级被旁路，链继续', eq(Array.from(r.out), [7, 8]), Array.from(r.out));
  ok('错误被记录到 fs.ERROR', !!r.st.ERROR && /炸了/.test(r.st.ERROR.msg), r.st.ERROR && r.st.ERROR.msg);

  const r2 = runChain([{ mod: getFunction('BadShape') }], Float64Array.from([7, 8]));
  ok('输出形状不符 → 旁路', eq(Array.from(r2.out), [7, 8]), Array.from(r2.out));
  ok('形状错误被记录', !!r2.st.ERROR && /形状/.test(r2.st.ERROR.msg), r2.st.ERROR && r2.st.ERROR.msg);
}

/* ---------- 6. 停用 / 抽头 ---------- */
console.log('停用 / 抽头');
{
  const r = runChain([{ mod: getFunction('inv'), inst: { on: false } }], Float64Array.from([0.2, 0.8]));
  ok('停用的级 = 旁路', eq(Array.from(r.out), [0.2, 0.8]));

  const st = mkFS();
  st.DSP_ARR = [compileChart({ stages: [{ id: 'inv', on: true, p: {} }] }, 'tap', { tapCap: 8 })];
  for (let i = 0; i < 3; i++) { st.INPUT = Float64Array.from([i / 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); DSPRun(st); }
  const b = st.DSP_ARR[0].instances[0];
  const h = tapHistory(b);
  ok('抽头记下了 3 帧 × 12 元素', h && h.count === 3 && h.n === 12, h && { count: h.count, n: h.n });
  ok('抽头首元素正确（反相后）', Math.abs(h[0] - 1) < 1e-9 && Math.abs(h[1 * 12 + 0] - 0.75) < 1e-9, h && Array.from(h.slice(0, 24)));
}

/* ---------- 7. Rank：并列 / 退化 / 不污染上游 ---------- */
console.log('Rank（vector 样板）');
{
  // 独立参考实现：排序后按并列段取中点（算法与模块的 less/equal 计数不同，用来互相印证）
  function refRank(src) {
    const n = src.length;
    const idx = Array.from({ length: n }, (_, i) => i).sort((x, y) => src[x] - src[y]);
    const out = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && Math.abs(src[idx[j + 1]] - src[idx[i]]) <= 1e-12) j++;
      const r = ((i + j) / 2) / (n - 1);
      for (let k = i; k <= j; k++) out[idx[k]] = r;
      i = j + 1;
    }
    return out;
  }
  const cases = [
    ['全不等', [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.25, 0.75]],
    ['全相等', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]],
    ['多组并列', [0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.5, 0.5, 0.2, 0.8, 0.3, 0.7]],
  ];
  for (const [name, c] of cases) {
    const want = refRank(c);
    const got = Array.from(runChain([{ mod: getFunction('rank') }], Float64Array.from(c)).out);
    ok(`rank ${name} 与参考实现一致`, got.every((v, i) => Math.abs(v - want[i]) < 1e-12), { got, want });
  }

  // 不污染上游：适配器给的是副本
  const src = Float64Array.from(cases[2][1]);
  const before = Array.from(src);
  runChain([{ mod: getFunction('rank') }], src);
  ok('不改上游输入（vector 拿到的 a 是副本）', eq(Array.from(src), before));

  // 临时缓冲跨帧复用：第二帧不能读到第一帧的残值
  const st = mkFS();
  st.DSP_ARR = [compileChart({ stages: [{ id: 'rank', on: true, p: {} }] }, 'rk')];
  st.INPUT = Float64Array.from(cases[2][1]);
  const f1 = Array.from(DSPRun(st));
  st.INPUT = Float64Array.from(cases[0][1]);
  const f2 = Array.from(DSPRun(st));
  const ok1 = f1.every((v, i) => Math.abs(v - refRank(cases[2][1])[i]) < 1e-12);
  const ok2 = f2.every((v, i) => Math.abs(v - refRank(cases[0][1])[i]) < 1e-12);
  ok('跨帧复用的临时缓冲不串味', ok1 && ok2, { f1, f2 });
}

console.log(`\n通过 ${pass}，失败 ${fail}。`);
process.exit(fail === 0 ? 0 : 1);

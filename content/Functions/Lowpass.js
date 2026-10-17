'use strict';

/* ============================================================
 * Lowpass —— 低通(时间)：对每个音级的 SFM 时间序列做一阶 IIR（指数平滑）
 *
 * 有状态算子样板（在 fs.hold 这类 helper 出现之前的"正确手写姿势"）：
 *   · 跨帧状态走 ST()，key 必须以 fs.FN_KEY 打头（多实例隔离）
 *   · 时间基准用 fs.TS（DSPRun 每帧设一次，同帧所有算子一致），不要各算子调 fs.now()
 *   · dt 首帧/异常给缺省，并 clamp（暂停恢复、切页回来都不会让滤波器炸）
 *   · 上一帧输出不允许用 `||` 判空 —— 0 是合法输出
 * ============================================================ */

registerFunction({
  id: 'lowpass',
  kind: 'vector',
  io: { in: 'vec12', out: 'vec12' },
  // 需要 fs（跨帧状态 ST/TS）—— 是否需要帧状态由页面按"f 源码是否引用 fs"自动检测，无需声明

  label: '低通(时间)',
  description: '一阶 IIR：对每个音级的 SFM 时间序列做指数平滑，压掉帧间抖动',
  category: '滤波',
  tags: 'filter lowpass 平滑 ema iir 滤波',

  paramSchema: [
    { name: 'tau', label: '时间常数s', type: 'number', default: 0.25,
      control: { type: 'NumberBox', fractionDigits: 2, step: 0.05, min: 0.02, max: 2 } },
  ],

  f: (a, p, fs) => {
    // 跨帧状态：ST 记录 { y: 上一帧输出, t: 上一帧 TS }。长度变了重建 = 从当前输入重新起步。
    const rec = ST(fs, fs.FN_KEY + '/lp', { y: null, t: null }).value;
    if (!rec.y || rec.y.length !== a.length) rec.y = Float64Array.from(a);

    // dt 用 fs.TS 差分（同帧恒定）；首帧给 20ms（50Hz 标称），之后钳 1ms~250ms（暂停恢复 / 切页兜底）
    const dt = (rec.t == null) ? 0.02
        : Math.min(0.25, Math.max(0.001, (fs.TS - rec.t) / 1000));
    rec.t = fs.TS;

    const tau = Number.isFinite(p.tau) ? Math.max(0.02, p.tau) : 0.25;   // 脏存档兜底
    const alpha = 1 - Math.exp(-dt / tau);
    for (let i = 0; i < a.length; i++) {
      rec.y[i] += alpha * (a[i] - rec.y[i]);   // 显式首帧起步（rec.y 已拷贝 a），不存在 || 判零问题
      a[i] = rec.y[i];                          // 就地改写 a（副本），交给下一级
    }
  },
});

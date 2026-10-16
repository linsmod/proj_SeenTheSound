#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
beat_follow_py.py — beat_follow.html 的 Python 频谱对照实验后端

目的：排查"长按琴键时图形幅度衰减"到底是谁的锅。
本版完全不经过 Web Audio：麦克风 PCM → numpy FFT → 字节频谱 → SSE 推给前端。
前端 beat_follow_py.html 的分频/音级分拣/环形缓冲/绘制逻辑与原版完全一致，
唯一变量就是频谱来源（Web Audio AnalyserNode vs Python FFT）。

页面上额外提供了两个实验开关：
  1. 平滑滑块   —— 模拟 AnalyserNode.smoothingTimeConstant（EMA），可调 0 关闭
  2. 基线扣除开关 —— 关掉 advanceBuffer 里的 buf.base 慢速基线
若关掉基线扣除后长按不再衰减 → 衰减是原版"显示超出基线的起伏"这一设计导致的，与音频链路无关。

bin 不均匀问题：
  FFT 的 bin 线性均匀（48kHz/8192 → 5.86Hz/bin），低频段一个 bin 横跨数个半音，
  "每盘只取落在该音级上的 bin" 在低频完全失真。--mode cqt 改用恒定 Q 变换（CQT）：
  每八度 36 个 bin（每半音 3 个）、对数等距；幅值定标与 FFT 路径一致
  （满幅正弦 ≈ 1.0 → 0dBFS），字节映射/阈值可直接沿用。前端按后端下发的每 bin
  中心频率表取数，FFT 模式行为不变（仍只发 binHz 标量），可随时 --mode fft 对照。
  CQT 默认频率范围对准钢琴 88 键（A0 27.5Hz – C8 4186Hz），栅格两端各外扩 1 个 bin
  （1/3 半音）让首尾的 A0 / C8 也各拿到 3 个 bin；页面音区每八度一区；
  注意最低频窗长 Q·fs/fmin ≈ 1.9s 超过 1 秒环形缓冲，会被截断（A0–G1 有效 Q 下降）。
  字节频谱已按 A 计权（IEC 61672）修正：低频读数随人耳响度下降而非物理电平，
  取代了原版每频段 boost 增益滑块（boost 无法表示八度内的斜率，且需手调）。

依赖:
    pip install flask numpy sounddevice
    （CQT 为纯 numpy 实现，无额外依赖）

用法:
    python beat_follow_py.py                 # 采集默认麦克风（默认 CQT）
    python beat_follow_py.py --device 2      # 指定输入设备索引
    python beat_follow_py.py --tone 440      # 内置恒幅正弦测试音（不经麦克风，彻底排除硬件/AGC）
    python beat_follow_py.py --mode fft      # 切回线性 FFT bin 做对照
    python beat_follow_py.py --fmin 27.5 --bpo 36  # CQT 参数（最低频/每八度 bin 数）
    python beat_follow_py.py --no-aweight      # 关闭 A 计权，看物理 dB 电平
浏览器打开: http://127.0.0.1:8000/
"""
import argparse
import base64
import json
import os
import threading
import time
from collections import deque

import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))

# Windows 定时器精度默认 ~15.6ms，time.sleep(会实际睡 ~15.6ms，60fps 的 16.7ms
# 帧间隔会被撑到 ~32ms（计算再快也上不去）。提升到 1ms 粒度，进程退出自动恢复。
try:
    import ctypes
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

FFT_SIZE = 8192                      # 与 beat_follow.html 的 analyser.fftSize 一致
DEFAULT_FS = 48000
MIN_DB, MAX_DB = -100.0, -30.0       # 对应 getByteFrequencyData 默认 min/maxDecibels
A_WEIGHTING =  False                  # A 计权（等响度）：按 bin 频率修正 dB，显示随人耳响度而非物理电平
FPS = 60
GATE_ENABLED = False    # 默认关闭逐格 onset 门控；如需开启，启动时去掉 --no-gate 或改回 True
FLAGS = {"gate": True}
SPEC = None             # 频谱引擎，__main__ 里按 --mode 创建；/set_aweight 切换时在其上重建加权曲线
GATE_HOLDER = {"obj": None, "a4": 440.0}   # OnsetGate 引用与音准参考；/set_a4 运行时切换并重建映射

# OnsetGate 可调参数：OnsetGate.process 每帧读取，/set_gate_params 实时修改
GATE_P = {
    # ---- onset 判定（决定何时开门）----
    "min_rise_db": 3.0,   # 单帧最小上升（dB）：抗稳态噪声的主闸门
    "thresh_mult": 1.6,   # 自适应阈值 = flux 中位数 × 倍数 + 下限
    "thresh_floor": 1.5,  # 阈值下限（dB）：抗"静音期间中位数为 0"
    "min_abs_db": -80.0,  # 绝对静音门限（dB）：防底噪误触
    "prev_ema": 0.6,      # prev_db 平滑系数 0~1：越大越抗单帧抖动
    # ---- AHDSR 包络（决定开门后的形状）----
    "attack": 0.005,      # A：0→1 斜坡时长（秒）；0 = 瞬时全开（旧行为）
    # H：各音区峰值保持时长（秒），低音余韵长、高音短（顺序同前端 ZONE_DEFS）
    "hold": [8.0, 6.0, 4.0, 3.0, 2.0, 1.5, 1.0, 0.6, 0.4],
    "decay": 0.6,         # D：1→Sustain 线性衰减时长（秒）
    "sustain": 0.3,       # S：持续电平 0~1（余韵期间的亮度）
    "note_off_db": -60.0, # 持续段内能量跌破此值 → 进入 Release（衰减到底/松键）
    "release_tau": 0.45,  # R：释放时间常数（秒），指数衰减到 0
}
GATE_HOLD_N = len(GATE_P["hold"])

# ---- CQT 配置（--mode cqt）：对数等距 bin，解决 FFT 线性 bin 低频分辨率不足 ----
# 频率范围对准钢琴 88 键：A0(27.5Hz) – C8(4186Hz)，前端音区按八度对齐划分。
# 栅格两端各外扩 1 个 bin（1/3 半音）：让 A0 的"平侧肩"、C8 的"锐侧肩"也有 bin，
# 于是 88 键每键都拿到 {note-1/3, note, note+1/3} 三个 bin（否则首尾各只有 2 个）。
CQT_BINS_PER_OCTAVE = 36  # 每八度 bin 数：36 → 每个半音 3 个 bin
CQT_PAD_BINS = 1                                      # 栅格向两端各外扩的 bin 数（0 = 严格 A0..C8）
CQT_FMIN = 27.5 * 2.0 ** (-CQT_PAD_BINS / CQT_BINS_PER_OCTAVE)    # ≈26.98Hz（A0 往下 1/3 半音）
CQT_FMAX = 4186.01 * 2.0 ** (CQT_PAD_BINS / CQT_BINS_PER_OCTAVE)  # ≈4267Hz（C8 往上 1/3 半音）

SM = {"alpha": 0.6}                  # 平滑系数（页面滑块实时改）

app = Flask(__name__)


def a_weight_db(freqs):
    """IEC 61672 A 计权曲线（dB，1kHz 归零）。

    低频为负、2kHz 附近略正：同一物理电平的低音读数更低，匹配"低频要响得多才被感知"。
    直接加在 dB 上使用（db_display = db + A(f)），不是反向补偿。
    """
    f = np.maximum(np.asarray(freqs, dtype=np.float64), 1e-6)
    f2 = f * f
    ra = (12194.0 ** 2 * f2 ** 2) / (
        (f2 + 20.6 ** 2)
        * np.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2))
        * (f2 + 12194.0 ** 2)
    )
    return 20.0 * np.log10(ra) + 2.00


class Capture:
    """麦克风采集（或内置测试音）→ 1 秒环形缓冲"""

    def __init__(self, fs, device=None, tone=None):
        self.fs = fs
        self.ring = np.zeros(fs, dtype=np.float32)  # 1 秒
        self.pos = 0
        self.lock = threading.Lock()
        self.tone = tone
        self.ok = False
        self.err = ""
        self._stream = None
        if tone is None:
            try:
                import sounddevice as sd
                self._stream = sd.InputStream(
                    samplerate=fs, channels=1, dtype="float32",
                    blocksize=1024, device=device, callback=self._cb)
                self._stream.start()
                self.ok = True
            except Exception as e:  # 设备/驱动问题直接报给页面
                self.err = f"{type(e).__name__}: {e}"
        else:
            self.ok = True

    def _cb(self, indata, frames, time_info, status):
        x = indata[:, 0]
        with self.lock:
            n = len(x)
            i = self.pos % self.fs
            end = i + n
            if end <= self.fs:
                self.ring[i:end] = x
            else:
                k = self.fs - i
                self.ring[i:] = x[:k]
                self.ring[:end - self.fs] = x[k:]
            self.pos += n

    def latest(self, n):
        """取最近 n 个样本（不足前面补零）"""
        if self.tone is not None:
            # 恒幅正弦 + 极小噪声：验证"信号本身不衰减时显示是否衰减"
            t = (self.pos + np.arange(n)) / self.fs
            x = 0.3 * np.sin(2 * np.pi * self.tone * t) + 1e-4 * np.random.randn(n)
            self.pos += n
            return x.astype(np.float32)
        i = (self.pos - n) % self.fs
        with self.lock:
            if i + n <= self.fs:
                return self.ring[i:i + n].copy()
            # 跨回绕点：第一段 ring[i:] 有 fs-i 个，第二段补足剩余 n-(fs-i) 个
            return np.concatenate([self.ring[i:], self.ring[:i + n - self.fs]])


class Spectrum:
    """PCM → blackman 窗 FFT → dBFS → 0..255 字节频谱（模拟 getByteFrequencyData）"""

    kind = "fft"                       # 线性均匀 bin

    def __init__(self, fs):
        self.fs = fs
        self.win = np.blackman(FFT_SIZE).astype(np.float64)
        self.win_sum2 = self.win.sum() / 2.0
        self.smoothed = None
        self.window = FFT_SIZE         # 每帧需要的样本数
        self.bin_freqs = (np.arange(FFT_SIZE // 2) + 0.5) * (fs / 2.0) / (FFT_SIZE // 2)
        self.a_weight = a_weight_db(self.bin_freqs) if A_WEIGHTING else None

    def compute(self, x):
        X = np.abs(np.fft.rfft(x.astype(np.float64) * self.win))[: FFT_SIZE // 2]
        mag = X / self.win_sum2                      # 振幅谱（满幅正弦 ≈ 1.0）
        self.last_mags = mag                # ← 新增：原始线性幅度，供 onset 检测
        db = 20.0 * np.log10(mag + 1e-12)
        if self.a_weight is not None:
            db = db + self.a_weight                  # A 计权：显示随人耳响度
        b = np.clip((db - MIN_DB) / (MAX_DB - MIN_DB), 0, 1) * 255.0
        a = SM["alpha"]
        if a > 0 and self.smoothed is not None:
            b = a * self.smoothed + (1 - a) * b      # 与 smoothingTimeConstant 同型 EMA
        self.smoothed = b
        return b.astype(np.uint8)


class CQTSpectrum:
    """PCM → CQT → dBFS → 0..255 字节频谱（对数等距 bin）

    FFT 的 bin 线性均匀（48kHz/8192 → 5.86Hz/bin），低频段一个 bin 横跨数个半音，
    音级分拣在低频完全失真。CQT 每八度固定 bpo 个 bin（默认 36 → 每半音 3 个），
    各 bin 窗长 N_k = Q·fs/f_k 随频率升高而缩短，全部右对齐到"当前帧"。

    幅值定标与 FFT 路径一致：核 = Hann 窗 × 复指数，响应除以 窗和/2，
    于是满幅正弦落在该 bin 中心频率时 mag ≈ 1.0（0 dBFS），
    MIN_DB/MAX_DB 字节映射与前端阈值可直接沿用。

    性能：低通抽取（DECIM）。CQT 最高 bin（4186Hz）远低于 fs/DECIM/2（6kHz），
    先把整窗信号降采样到 fs_d = fs/DECIM 再算核，核长 N_k 同步 ÷DECIM——
    原瓶颈正是低频长核（A0 起 32 个 bin 被 1 秒窗钳制、各 48000 点复点积，
    262 个核共 ~400 万复 MAC/帧、核内存 ~64MB 全走内存带宽）。
    核形不变（hanning(N)·exp(2πi f N/fs_d) 即全速率核按 DECIM 抽取），
    带外只有核旁瓣本就要抑制的成分，幅值误差可忽略。
    """

    kind = "cqt"                       # 对数等距 bin
    DECIM = 4                          # 低通抽取倍数（fs_d = fs/4 = 12kHz）

    def __init__(self, fs, fmin=CQT_FMIN, fmax=CQT_FMAX, bpo=CQT_BINS_PER_OCTAVE, a4=440.0):
        self.fs = fs
        self.bpo = bpo
        self.a4 = a4                                 # 音准参考（/set_a4 可切，整条 CQT 栅格随其缩放）
        self.fmin0, self.fmax0 = fmin, fmax          # 440 参考下的标称频率范围
        self._lp_len = -1
        self._lp_mask = None
        self.smoothed = None
        self._build()
        # 预热：触发 FFT 计划与矩阵内存首触，避免服务首帧尖峰
        self.compute(np.zeros(self.window, dtype=np.float64))
        self.smoothed = None

    def _build(self):
        """按当前 a4 重建 CQT 栅格与全部核。

        fmin/fmax 同比缩放（×a4/440）→ fmax/fmin 比值不变 → n_bins 不变，
        仅整条频率表平移；bin 数恒定使 smoothed EMA 长度兼容，可直接续用。
        """
        fs, bpo = self.fs, self.bpo
        scale = self.a4 / 440.0
        fmax = min(self.fmax0 * scale, fs / 2.0 * 0.98)
        fmin = min(max(self.fmin0 * scale, 20.0), fmax / 2.0)
        n_bins = int(np.floor(bpo * np.log2(fmax / fmin))) + 1
        bin_freqs = fmin * 2.0 ** (np.arange(n_bins) / bpo)
        q = 1.0 / (2.0 ** (1.0 / bpo) - 1.0)         # 恒定 Q 值（1/3 半音间距 → Q≈50.4）
        # ---- 抽取域参数 ----
        d = self.DECIM
        fs_d = fs / d                                # 抽取后采样率（核就在这个域里算）
        # 最长窗（最低频 bin）不超过 1 秒环形缓冲；fmin 过低时最低频 bin 窗长被截断
        ideal_window = int(np.ceil(q * fs_d / fmin))
        window = min(int(np.ceil(q * fs / fmin)), fs)  # 每帧取样数（整秒，抽取在 compute 内做）
        window_d = max(1, window // d)               # 抽取后窗长
        # 预计算每 bin 的共轭核与幅值定标（长度已按抽取域缩短）
        kernels, gains = [], []
        for f in bin_freqs:
            n = min(window_d, int(np.ceil(q * fs_d / f)))
            w = np.hanning(n)
            kernels.append((w * np.exp(2j * np.pi * f * np.arange(n) / fs_d)).conj())
            gains.append(2.0 / w.sum())              # 满幅正弦 → 1.0
        # ---- 分组矩阵：核长按 2 的幂分桶，组内左侧补零、共用一个右对齐信号段 ----
        # 补零不改变点积值；整组一次 ZGEMV。逐个 np.dot 只有 ~1 亿复MAC/s，
        # ZGEMV ~20 亿复MAC/s——262 个核的点积从 ~9.6ms 降到 ~1ms。
        buckets = {}
        for k, c in enumerate(kernels):
            g = 1 << max(0, (len(c) - 1).bit_length())   # 核长向上取 2 的幂
            buckets.setdefault(g, []).append(k)
        groups = []                                    # [(bin 索引, 核矩阵, 增益)]
        for g, idxs in sorted(buckets.items()):
            width = max(len(kernels[k]) for k in idxs)   # 组宽 = 组内最大核长
            K = np.zeros((len(idxs), width), dtype=np.complex128)
            gns = np.empty(len(idxs))
            for row, k in enumerate(idxs):
                c = kernels[k]
                K[row, width - len(c):] = c            # 右对齐，左侧补零
                gns[row] = gains[k]
            groups.append((np.asarray(idxs), K, gns))
        # 一次性赋值（与 SSE 线程并发时至多一帧旧新混用，无害）
        self.bin_freqs = bin_freqs
        self.fs_d = fs_d
        self.window = window
        self.window_d = window_d
        self.window_clamped = ideal_window > window_d
        self._kernels, self._gain = kernels, gains
        self._groups = groups
        self.a_weight = a_weight_db(bin_freqs) if A_WEIGHTING else None

    def set_a4(self, a4):
        """切换音准参考并重建 CQT 栅格（bin 数不变，smoothed EMA 可续用）。"""
        if a4 != self.a4:
            self.a4 = a4
            self._build()

    def _lowpass_decimate(self, x):
        """FFT 砖壁低通（截止 fs_d/2）→ 按 DECIM 抽取：目标频段 ≤4186Hz 全保留"""
        n = len(x)
        if self._lp_len != n:
            fr = np.fft.rfftfreq(n, 1.0 / self.fs)
            self._lp_mask = fr <= self.fs_d / 2.0
            self._lp_len = n
        X = np.fft.rfft(x)
        X[~self._lp_mask] = 0
        return np.fft.irfft(X, n=n)[::self.DECIM]

    def compute(self, x):
        x = np.asarray(x, dtype=np.float64)
        xd = self._lowpass_decimate(x)   # 48000 → 12000 样本（12kHz）
        L = len(xd)
        mags = np.empty(len(self._kernels))
        for idxs, K, gains in self._groups:
            seg = xd[L - K.shape[1]:]                   # 组内公共右对齐段
            mags[idxs] = np.abs(K @ seg) * gains        # 整组一次 ZGEMV
        self.last_mags = mags               # ← 新增
        db = 20.0 * np.log10(mags + 1e-12)
        if self.a_weight is not None:
            db = db + self.a_weight                  # A 计权：显示随人耳响度
        b = np.clip((db - MIN_DB) / (MAX_DB - MIN_DB), 0, 1) * 255.0
        a = SM["alpha"]
        if a > 0 and self.smoothed is not None:
            b = a * self.smoothed + (1 - a) * b      # 与 smoothingTimeConstant 同型 EMA
        self.smoothed = b
        return b.astype(np.uint8)

class OnsetGate:
    """钢琴击弦 onset 检测 + 逐格 AHDSR 门控（按音区 × 音级）。

    对每个 (音区, 音级) 单元格：
      1. 该格所有 bin 线性幅度均值 → dB
      2. 帧间正通量 flux = max(0, db - prev_db)
      3. 用最近 ~0.7s flux 中位数做自适应阈值
      4. flux > 阈值 且 > MIN_RISE_DB → 判定为击弦，启动 AHDSR 包络：
         A(0→1 斜坡) → H(峰值保持, 按音区) → D(衰减到 S) →
         S(持续, 直到能量跌破 note_off_db) → R(指数释放到 0)
      5. 输出 9×12 门增益，随 SSE 下发，前端乘到每格幅度上

    连续噪声/人声/弦乐渐强没有陡上升沿，通量低 → 门一直关，被抑制。
    """

    # 88 键音区（与前端 ZONE_DEFS 一致）
    ZONES_MIDI = (
        (21, 23), (24, 35), (36, 47), (48, 59), (60, 71),
        (72, 83), (84, 95), (96, 107), (108, 108),
    )

    def __init__(self, fs, bin_freqs, fps=FPS, a4=440.0):
        self.fs = fs
        self.fps = fps
        self.n_zones = len(self.ZONES_MIDI)
        self.n_pc = 12
        self.frame_dt = 1.0 / fps
        self.a4 = a4                                 # 音准参考（/set_a4 运行时可切）
        self.bin_freqs = np.asarray(bin_freqs, dtype=np.float64)
        self._build_bins()

        # 逐格状态
        self.prev_db = np.full((self.n_zones, self.n_pc), -120.0)
        H = int(round(0.7 * fps))          # ~0.7s flux 历史
        self.flux_hist = np.zeros((H, self.n_zones, self.n_pc))
        self.hist_pos = 0
        self.hist_count = 0
        # AHDSR 状态机（逐格）：0=off 1=attack 2=hold 3=decay 4=sustain 5=release
        self.env_stage = np.zeros((self.n_zones, self.n_pc), dtype=np.int8)
        self.env_level = np.zeros((self.n_zones, self.n_pc))
        self.env_t = np.zeros((self.n_zones, self.n_pc))

        # ---- 可调参数：见模块级 GATE_P（/set_gate_params 实时改，process 每帧读取）----

    def _build_bins(self):
        """按当前 a4 重建每格 bin 索引：每个 bin 归到"最近的音"（round），该音符同时决定行(zone)与列(pc)。

        与前端 ensurePitchClassBins / drawBinScatter 同一口径；音符正落在 bin 中心，
        于是每格拿到 {note-1/3, note, note+1/3} 三颗、关于音符对称。
        （原按 key_hz(lo) <= f <= key_hz(hi) 过滤，会把每八度 B 的上面两颗丢进 zone 间隙）
        """
        self.cell_bins = [[] for _ in range(self.n_zones * self.n_pc)]
        for i, f in enumerate(self.bin_freqs):
            midi = 69 + 12 * np.log2(max(f, 1e-6) / self.a4)
            note = int(round(midi))
            pc = note % 12
            for z, (lo, hi) in enumerate(self.ZONES_MIDI):
                if lo <= note <= hi:                     # 行 = 该音符所属音区
                    self.cell_bins[z * self.n_pc + pc].append(i)
                    break
        self.cell_bins = [np.asarray(b, dtype=np.int64) for b in self.cell_bins]

    def set_a4(self, a4, bin_freqs=None):
        """切换音准参考并重建 bin→音 映射（包络状态按格索引保留，无需清零）。

        bin_freqs：可选的新频率表（CQT 栅格随 a4 缩放后由 /set_a4 传入）；
        表或 a4 任一变化都重建映射。
        """
        rebuild = False
        if bin_freqs is not None:
            bin_freqs = np.asarray(bin_freqs, dtype=np.float64)
            if bin_freqs.shape != self.bin_freqs.shape or not np.array_equal(bin_freqs, self.bin_freqs):
                self.bin_freqs = bin_freqs
                rebuild = True
        if a4 != self.a4:
            self.a4 = a4
            rebuild = True
        if rebuild:
            self._build_bins()

    def process(self, mags_linear, dt):
        """mags_linear: (n_bins,) 线性幅度；返回 gate_gain (n_zones, n_pc) ∈ [0,1]"""
        P = GATE_P  # 每帧读最新参数（/set_gate_params 实时生效）
        cur_db = np.full((self.n_zones, self.n_pc), -120.0)
        for k, idxs in enumerate(self.cell_bins):
            if idxs.size:
                z, pc = divmod(k, self.n_pc)
                m = float(np.mean(mags_linear[idxs]))
                cur_db[z, pc] = 20.0 * np.log10(m + 1e-12)

        # 正通量
        flux = np.maximum(0.0, cur_db - self.prev_db)
        self.prev_db = P["prev_ema"] * self.prev_db + (1.0 - P["prev_ema"]) * cur_db

        # 写入历史
        self.flux_hist[self.hist_pos] = flux
        self.hist_pos = (self.hist_pos + 1) % self.flux_hist.shape[0]
        self.hist_count = min(self.hist_count + 1, self.flux_hist.shape[0])

        # 自适应阈值
        if self.hist_count >= 8:
            med = np.median(self.flux_hist[:self.hist_count], axis=0)
        else:
            med = np.zeros_like(flux)
        thr = med * P["thresh_mult"] + P["thresh_floor"]

        # onset 判定
        onset = (flux > thr) & (flux > P["min_rise_db"]) & (cur_db > P["min_abs_db"])

        # ---- AHDSR 包络状态机（逐格推进）----
        A, D, S = P["attack"], P["decay"], P["sustain"]
        hold = np.asarray(P["hold"], dtype=np.float64)   # (n_zones,)
        tau, off_db = P["release_tau"], P["note_off_db"]
        stage, lvl, t = self.env_stage, self.env_level, self.env_t

        # onset → 从 Attack 重启（连奏/踏板自然刷新整段包络）
        if onset.any():
            stage[onset] = 1
            t[onset] = 0.0

        # A：0→1 线性斜坡（从当前电平起，retrigger 不回落到 0）
        m = stage == 1
        if A > 0:
            t[m] += dt
            lvl[m] = np.minimum(1.0, lvl[m] + dt / A)
        else:
            lvl[m] = 1.0
        done = m & (lvl >= 1.0)
        stage[done] = 2
        t[done] = 0.0

        # H：峰值保持（按音区时长）
        m = stage == 2
        t[m] += dt
        done = m & (t >= hold[:, None])
        stage[done] = 3
        t[done] = 0.0

        # D：1→S 线性衰减
        m = stage == 3
        t[m] += dt
        if D > 0:
            lvl[m] = 1.0 + (S - 1.0) * np.clip(t[m] / D, 0.0, 1.0)
        else:
            lvl[m] = S
        done = m & (t >= D)
        stage[done] = 4
        t[done] = 0.0

        # S：持续段——能量跌破 note_off_db（衰减到底/松键）→ Release
        m = stage == 4
        done = m & (cur_db < off_db)
        stage[done] = 5
        t[done] = 0.0

        # R：指数衰减到 0
        m = stage == 5
        lvl[m] *= np.exp(-dt / tau)
        done = m & (lvl < 0.002)
        lvl[done] = 0.0
        stage[done] = 0

        return lvl


def sse_stream(cap, spec):
    interval = 1.0 / FPS
    stamps = deque()
    gate = OnsetGate(cap.fs, spec.bin_freqs, a4=GATE_HOLDER["a4"]) if GATE_ENABLED else None
    GATE_HOLDER["obj"] = gate
    last_t = time.perf_counter()
    while True:
        t0 = time.perf_counter()
        x = cap.latest(spec.window)
        b = spec.compute(x)
        now = time.perf_counter()
        dt = min(now - last_t, 0.1)     # 钳制：卡顿/切页时 dt 别爆
        last_t = now

        stamps.append(now)
        while stamps and now - stamps[0] > 1.0:
            stamps.popleft()

        payload = {
            "s": base64.b64encode(b.tobytes()).decode(),
            "kind": spec.kind,
            "fs": cap.fs,
            "fps": FPS,
            "rfps": len(stamps),
            "err": cap.err,
        }

        # ---- 逐格 onset 门控 ----
        if gate is not None:
            g = gate.process(spec.last_mags, dt)
            payload["gate"] = base64.b64encode(
                np.round(g * 255.0).astype(np.uint8).tobytes()).decode()

        if spec.kind == "cqt":
            payload["freqs"] = spec.bin_freqs.tolist()
            payload["bpo"] = spec.bpo
        else:
            payload["binHz"] = (cap.fs / 2.0) / (FFT_SIZE // 2)

        yield f"data: {json.dumps(payload)}\n\n"
        dt_work = time.perf_counter() - t0
        if dt_work < interval:
            time.sleep(interval - dt_work)


@app.route("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.route("/matrix")
def matrix():
    """参数化矩阵页：管道位置 × 变换函数 的图表矩阵（数据源与主面板同为 /stream）"""
    return send_from_directory(HERE, "matrix.html")


@app.route("/stream")
def stream():
    return Response(sse_stream(CAP, SPEC),
                    mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/set_smoothing")
def set_smoothing():
    try:
        SM["alpha"] = min(0.95, max(0.0, float(request.args.get("v", 0.6))))
    except ValueError:
        pass
    return jsonify({"alpha": SM["alpha"]})


@app.route("/set_a4")
def set_a4():
    """实时切音准参考 A4（页面瓦片调用，440/432）。

    OnsetGate 的 bin→音 映射按 a4 重建，门控列与前端对齐；
    包络状态按格索引保留，无需清零。不带参数 = 返回当前值。
    """
    v = request.args.get("v")
    if v is not None:
        try:
            a4 = float(v)
        except ValueError:
            a4 = 440.0
        if 400.0 <= a4 <= 480.0:
            GATE_HOLDER["a4"] = a4
            # CQT：整条栅格随 a4 缩放重建（FFT 栅格与调音无关，跳过）
            if SPEC is not None and getattr(SPEC, "kind", "") == "cqt" and hasattr(SPEC, "set_a4"):
                SPEC.set_a4(a4)
            if GATE_HOLDER["obj"] is not None:
                # 用 SPEC 重建后的新频率表重排门控映射，保证与前端列对齐
                GATE_HOLDER["obj"].set_a4(a4, SPEC.bin_freqs if SPEC is not None else None)
    return jsonify({"a4": GATE_HOLDER["a4"]})


@app.route("/set_aweight")
def set_aweight():
    """实时开关 A 计权（页面复选框调用），等效 --no-aweight 的运行时版。

    a_weight 曲线在 Spectrum/CQTSpectrum 构造时按 bin 频率预算，
    切换时在现有 SPEC 对象上重建即可，无需重开音频流。
    不带参数 = 返回当前状态（前端加载时同步复选框）。
    """
    global A_WEIGHTING
    v = request.args.get("v")
    if v is not None:
        A_WEIGHTING = v not in ("0", "false", "False")
        if SPEC is not None:
            SPEC.a_weight = a_weight_db(SPEC.bin_freqs) if A_WEIGHTING else None
    return jsonify({"aweight": A_WEIGHTING})


@app.route("/set_gate_params")
def set_gate_params():
    """实时改 OnsetGate 参数（页面滑块调用）。

    支持 min_rise_db / thresh_mult / thresh_floor / min_abs_db / prev_ema /
    attack / decay / sustain / note_off_db / release_tau /
    hold(逗号分隔 9 个音区秒数)。
    不带参数 = 返回当前值（前端加载时同步滑块）。越界/非法的值忽略。
    """
    def _set(key, val, lo, hi):
        try:
            f = float(val)
        except (TypeError, ValueError):
            return
        if lo <= f <= hi:
            GATE_P[key] = f

    for key, lo, hi in (
        ("min_rise_db", 0.0, 20.0),
        ("thresh_mult", 1.0, 8.0),
        ("thresh_floor", 0.0, 20.0),
        ("release_tau", 0.05, 5.0),
        ("min_abs_db", -120.0, 0.0),
        ("prev_ema", 0.0, 0.95),
        ("attack", 0.0, 1.0),
        ("decay", 0.0, 10.0),
        ("sustain", 0.0, 1.0),
        ("note_off_db", -120.0, 0.0),
    ):
        v = request.args.get(key)
        if v is not None:
            _set(key, v, lo, hi)

    hold = request.args.get("hold")
    if hold:
        try:
            vals = [float(x) for x in hold.split(",")]
        except ValueError:
            vals = []
        if len(vals) == GATE_HOLD_N:
            GATE_P["hold"] = [min(30.0, max(0.0, v)) for v in vals]

    return jsonify(GATE_P)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--device", type=int, default=None, help="sounddevice 输入设备索引")
    ap.add_argument("--fs", type=int, default=DEFAULT_FS)
    ap.add_argument("--tone", type=float, default=None,
                    help="内置恒幅正弦频率(Hz)，代替麦克风做纯算法对照")
    ap.add_argument("--mode", choices=["fft", "cqt"], default="cqt",
                    help="fft=线性均匀 bin（原 Web Audio 对照）；cqt=每八度 12 bin 对数等距，解决低频 bin 分辨率不足")
    ap.add_argument("--fmin", type=float, default=CQT_FMIN, help="CQT 最低 bin 中心频率(Hz)")
    ap.add_argument("--fmax", type=float, default=CQT_FMAX, help="CQT 目标最高 bin 中心频率(Hz)")
    ap.add_argument("--bpo", type=int, default=CQT_BINS_PER_OCTAVE, help="CQT 每八度 bin 数")
    ap.add_argument("--no-aweight", action="store_true",
                    help="关闭 A 计权（等响度修正），显示回到物理 dB 电平")
    ap.add_argument("--no-gate", action="store_true",
                help="关闭逐格 onset 门控（保留全部成分）")                    
    args = ap.parse_args()

    if args.no_aweight:
        A_WEIGHTING = False
    if args.no_gate:
        GATE_ENABLED = False
    FLAGS["gate"] = not args.no_gate
    CAP = Capture(args.fs, args.device, args.tone)
    if args.mode == "cqt":
        SPEC = CQTSpectrum(args.fs, args.fmin, args.fmax, args.bpo)
    else:
        SPEC = Spectrum(args.fs)
    if not CAP.ok:
        print(f"[警告] 麦克风打开失败: {CAP.err}")
        print("       可改用测试音模式: python beat_follow_py.py --tone 440")
    else:
        src = f"测试音 {args.tone}Hz" if args.tone else f"麦克风 fs={args.fs}"
        if SPEC.kind == "cqt":
            spec_info = (f"CQT {len(SPEC.bin_freqs)}bin · "
                         f"{SPEC.bin_freqs[0]:.1f}–{SPEC.bin_freqs[-1]:.0f}Hz · "
                         f"{args.bpo}/oct · 最长窗 {SPEC.window}样本")
            if SPEC.window_clamped:
                print(f"[注意] 最低频理想窗长超过 1 秒环形缓冲，已截断为 {SPEC.window} 样本"
                      f"（A0–G1 有效 Q 下降，相邻半音略有相混）")
        else:
            spec_info = f"FFT={FFT_SIZE} · binHz={(args.fs / 2) / (FFT_SIZE // 2):.2f}"
        spec_info += " · A计权" + ("开" if A_WEIGHTING else "关")
        print(f"[OK] 音源: {src}, {spec_info}")
    print(f"[OK] http://127.0.0.1:{args.port}/")
    app.run(host="127.0.0.1", port=args.port, threaded=True, use_reloader=False)

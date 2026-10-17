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
import binascii
import json
import os
import re
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


@app.route("/dsp-lab")
def dsp_lab():
    """Sound DSP 实验室页 （数据源与主面板同为 /stream）"""
    resp = send_from_directory(HERE, "dsp-lab.html")
    # 这一页在开发期改得很勤：不许缓存，否则改完刷新看到的还是旧 JS，
    # 排查问题时会被"上一版构建的日志"骗半天。
    resp.headers["Cache-Control"] = "no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


# ---- 前端函数库：content/Functions/*.js 直接静态下发 ----
# DSP 处理核心的模块脚本（Processor / Compile / 各算子）由页面用 <script src> 引入。
# 只放行 .js：这是"代码目录"，别顺手把 content/ 下的用户数据一起带出去；
# send_from_directory 自带路径穿越防护（../ 一律 404）。
FUNC_DIR = os.path.join(HERE, "content", "Functions")


@app.route("/content/Functions/<path:name>")
def func_module(name):
    if not name.lower().endswith(".js"):
        return jsonify({"ok": False, "error": "only .js is served here"}), 404
    resp = send_from_directory(FUNC_DIR, name, mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-cache"      # 改完刷新生效，别被浏览器缓存骗
    return resp


@app.route("/stream")
def stream():
    return Response(sse_stream(CAP, SPEC),
                    mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---- Sound DSP 实验室页的文档存储：一张 JSON 落在 content/ViewState/ 里 ----
# 左栏 = 带预览的文件列表，右栏 = 编辑器标签页；保存/读取都走后端，
# 存档跟着项目走（换浏览器、清缓存都不丢），也方便直接用编辑器/git 看 diff。
# 落盘用"先写临时文件再改名"的原子替换：写到一半断电不会留下半个坏 JSON。
DOC_PATH = os.path.join(HERE, "content", "ViewState", "dsp-lab.json")


@app.route("/api/doc", methods=["GET"])
def api_doc_get():
    """读取整份文档。不存在返回 exists:false（前端退回出厂配置），损坏则返回 500 而不是空文档。"""
    try:
        with open(DOC_PATH, "r", encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        return jsonify({"exists": False})
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as e:
        return jsonify({"error": f"{DOC_PATH} 不是合法 JSON：{e}"}), 500
    return jsonify({"exists": True, "doc": doc, "path": DOC_PATH})


@app.route("/api/doc", methods=["POST"])
def api_doc_post():
    """整份覆盖写回。前端已做清洗，这里只兜住非法 JSON 与超大体积。

    charts 允许为空数组：DSP 实验室的内容真相已经全在 content/ 下，
    DOC 只保留视图状态与「我的图」的内存镜像。
    """
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("charts"), list):
        return jsonify({"error": "请求体必须是 {charts:[...] }"}), 400
    tmp = DOC_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=2)
        os.replace(tmp, DOC_PATH)     # 同目录改名是原子的：读到的要么是旧的完整文档，要么是新的完整文档
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return jsonify({"error": f"写入失败：{e}"}), 500
    return jsonify({"ok": True, "path": DOC_PATH, "charts": len(body["charts"])})


# ---- 内容根：content/ 下的全部 DSP 文件与视图状态 ----
#   content/Templates/  出厂预设，只读（要改由前端「从模板新建」克隆成自己的图）
#   content/My dsps/    我的图，可读写（新建 / 改名 / 改链 / 删除）
#   content/Snapshots/  画布快照 PNG（暂停时落盘，恢复播放时删掉）
#   content/ViewState/  dsp-lab.json（页面文档：图表 + 视图状态）
# 前端左栏的树直接扫 content/ 生成（/api/tree），只列 .json；目录结构即磁盘结构。
CONTENT_DIR = os.path.join(HERE, "content")
CONTENT_PREFIX = "content/"
TPL_DIR = os.path.join(CONTENT_DIR, "Templates")
TPL_PREFIX = "content/Templates/"
DSP_DIR = os.path.join(CONTENT_DIR, "My dsps")
DSP_PREFIX = "content/My dsps/"
SHOT_DIR = os.path.join(CONTENT_DIR, "Snapshots")
SHOT_PREFIX = "content/Snapshots/"
CMPV_DIR = os.path.join(CONTENT_DIR, "Compares")
CMPV_PREFIX = "content/Compares/"
ITEM_EXTS = (".json", ".cmpv")       # 树 / 列表里认的内容文件：DSP 链 + 对比视图
# 我的图的文件名 = 图的 id（untitled、untitled-2…，与对比视图同一套命名）：身份稳定，改标题不必改名，也不会撞中文名/空格
DSP_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# 历史内置 id（input / lab / c1–c8）：旧文档里出现过，不该被当成"我的图"迁移成文件。
# 新版已废弃这些内置条目（内容真相全在 content/ 下），这里只作迁移时的排除名单。
BUILTIN_IDS = {"input", "lab"} | {f"c{i}" for i in range(1, 9)}


def _dir_item(dirpath, prefix, name):
    """读一个内容文件（.json / .cmpv）→ 前端用的条目；越界名 / 坏文件一律当不存在。"""
    if not name or not name.endswith(ITEM_EXTS):
        return None
    if "/" in name or "\\" in name or ".." in name or name.startswith("."):
        return None
    p = os.path.abspath(os.path.join(dirpath, name))
    if os.path.dirname(p) != os.path.abspath(dirpath):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(d, dict):
        return None
    stem = name.rsplit(".", 1)[0]
    item = {
        "file": prefix + name,
        "name": stem,
        "kind": "cmpv" if name.endswith(".cmpv") else "dsp",
        "title": d.get("title") if isinstance(d.get("title"), str) else stem,
        "desc": d.get("desc") if isinstance(d.get("desc"), str) else "",
    }
    if item["kind"] == "cmpv":
        # 对比视图：只存目标文件路径（其它字段忽略）
        item["targets"] = [t for t in (d.get("targets") or []) if isinstance(t, str)]
    else:
        item["stages"] = d.get("stages") if isinstance(d.get("stages"), list) else []
    return item


def _dir_list(dirpath, prefix):
    try:
        names = sorted(n for n in os.listdir(dirpath) if n.endswith(ITEM_EXTS))
    except FileNotFoundError:
        names = []
    return [i for i in (_dir_item(dirpath, prefix, n) for n in names) if i]


def _dsp_path(name):
    """名字带不带 .json 都认（URL 里传的是完整文件名），只认 id 形态的 stem。"""
    stem = name[:-5] if isinstance(name, str) and name.endswith(".json") else name
    if not stem or not DSP_NAME_RE.match(stem):
        return None
    return os.path.join(DSP_DIR, stem + ".json")


def _dsp_write(name, body):
    """原子写：先写 .tmp 再改名。返回写完读回的条目。"""
    p = _dsp_path(name)
    if not p:
        return None
    stem = os.path.basename(p)[:-5]
    os.makedirs(DSP_DIR, exist_ok=True)
    out = {
        "title": body.get("title") if isinstance(body.get("title"), str) else name,
        "desc": body.get("desc") if isinstance(body.get("desc"), str) else "",
        "stages": body.get("stages") if isinstance(body.get("stages"), list) else [],
    }
    # from 不写：从模板创建出来之后就是独立一条，不记来源，也没有"恢复出厂"可回
    tmp = p + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None
    return _dir_item(DSP_DIR, DSP_PREFIX, stem + ".json")


def _dsp_migrate_once():
    """首次访问我的图：把 content/ViewState/dsp-lab.json 里的用户图（非内置 id）搬成 content/My dsps/*.json。
    目录里已经有文件就什么都不做 —— 迁移只发生一次，之后文件才是真相。"""
    try:
        if any(n.endswith(".json") for n in os.listdir(DSP_DIR)):
            return
    except FileNotFoundError:
        pass
    try:
        with open(DOC_PATH, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    for c in doc.get("charts") or []:
        if not isinstance(c, dict):
            continue
        cid = c.get("id")
        if not isinstance(cid, str) or cid in BUILTIN_IDS or not DSP_NAME_RE.match(cid):
            continue
        _dsp_write(cid, c)


# ---- content/ 目录树：前端左栏的树据此渲染（目录结构 = 磁盘结构，文件只列 .json） ----
TREE_NODE_NAME = "$treeNode.json"
VIEW_NAMES = ("dsplistview", "dspview")     # 与前端 VIEWS 白名单一致


def _dir_treenode(dirpath):
    """目录级描述符 $treeNode.json → {text, viewtype}。

    有它 = 这个目录可以被"打开"（按 viewtype 渲染）；没有 / 解析失败 / viewtype 不认识
    = 纯文件夹，前端只让它展开收起，不进内容面板。
    形态宽容：既认 `{...}` 也认 `[{...}]`（现有文件是单元素数组）。
    """
    try:
        with open(os.path.join(dirpath, TREE_NODE_NAME), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return None
    if isinstance(raw, list):
        raw = raw[0] if raw and isinstance(raw[0], dict) else None
    if not isinstance(raw, dict):
        return None
    vt = raw.get("viewtype")
    if not isinstance(vt, str) or vt not in VIEW_NAMES:
        return None
    text = raw.get("text")
    return {"text": text.strip() if isinstance(text, str) else "", "viewtype": vt}


def _content_tree(dirpath, prefix):
    """递归扫一个目录 → 节点表：目录节点（带 children）在前，内容文件在后，各自按名排序。

    只收 .json / .cmpv（快照 PNG、临时文件之类的杂项不进树）：树是"能打开的内容"的导航。
    坏 JSON / 越界名由 _dir_item 兜住 —— 解不出来就当这个文件不存在。
    """
    try:
        names = sorted(os.listdir(dirpath))
    except FileNotFoundError:
        return []
    dirs, files = [], []
    for n in names:
        if n.startswith("."):
            continue
        p = os.path.join(dirpath, n)
        if os.path.isdir(p):
            child = prefix + n + "/"
            nd = {"kind": "dir", "name": n, "path": child,
                  "children": _content_tree(p, child)}
            tn = _dir_treenode(p)          # 目录描述符：有才带 treeNode，前端据此决定"能不能打开"
            if tn:
                nd["treeNode"] = tn
            dirs.append(nd)
        elif n.startswith("$"):
            continue                       # $ 开头 = 元数据（$schema / $treeNode），不是内容条目
        elif n.endswith(ITEM_EXTS):
            item = _dir_item(dirpath, prefix, n)
            if not item:
                continue
            node = {"kind": "file", "name": n, "path": item["file"],
                    "title": item["title"], "desc": item["desc"]}
            if item["kind"] == "cmpv":
                node["targets"] = item["targets"]
            else:
                node["stages"] = item["stages"]
            files.append(node)
    return dirs + files


def _flatten_files(nodes, out):
    """把树里的文件节点摊平成条目（前端 itemOf / itemsOf 用的索引）：字段按类型带过去。"""
    for nd in nodes:
        if nd["kind"] == "file":
            entry = {"file": nd["path"], "name": nd["name"].rsplit(".", 1)[0],
                     "title": nd["title"], "desc": nd["desc"]}
            if "targets" in nd:
                entry["targets"] = nd["targets"]
            else:
                entry["stages"] = nd["stages"]
            out.append(entry)
        else:
            _flatten_files(nd["children"], out)
    return out


@app.route("/api/tree")
def api_tree():
    """整棵 content/ 树：目录结构 + 每个 .json 的条目（带 title/desc/stages）。

    前端一次拉回即可渲染左栏树并建索引，不必再按目录逐个拉清单。
    """
    tree = _content_tree(CONTENT_DIR, CONTENT_PREFIX)
    return jsonify({"root": CONTENT_PREFIX, "tree": tree, "files": _flatten_files(tree, [])})


@app.route("/api/item")
def api_item():
    """按完整相对路径（content/ 下）取单个文件条目：树清单之外新加的文件也能直接打开。"""
    rel = request.args.get("path", "")
    if not isinstance(rel, str):
        return jsonify({"error": "路径不合法"}), 400
    rel = rel.replace("\\", "/")
    if ".." in rel or not rel.startswith(CONTENT_PREFIX) or not rel.endswith(ITEM_EXTS):
        return jsonify({"error": "路径不合法"}), 400
    base = os.path.abspath(CONTENT_DIR)
    full = os.path.abspath(os.path.join(HERE, *[s for s in rel.split("/") if s]))
    if not full.startswith(base + os.sep):
        return jsonify({"error": "路径越界"}), 400
    dirpath, fname = os.path.split(full)
    sub = os.path.relpath(dirpath, base).replace("\\", "/")
    prefix = CONTENT_PREFIX + ("" if sub == "." else sub + "/")
    item = _dir_item(dirpath, prefix, fname)
    if not item:
        return jsonify({"error": "这一条不存在或不是合法 JSON"}), 404
    return jsonify({"item": item})


# ---- 对比视图（.cmpv）：content/Compares/<name>.cmpv = { title, desc, targets:[DSP 文件路径] } ----
# 一份 .cmpv 只记"要比哪几条"，不复制内容；打开它时前端用卡片列表渲染这些目标。
CMPV_NAME_RE = re.compile(r"^[A-Za-z0-9 _-]+$")


def _cmpv_write(name, body):
    """原子写一份 .cmpv。targets 只收 content/ 下的 .json 路径（去重、保持顺序）；没有有效目标就拒写。"""
    targets, seen = [], set()
    for t in (body.get("targets") or []):
        if not isinstance(t, str) or not t.endswith(".json"):
            continue
        if not t.startswith(CONTENT_PREFIX) or ".." in t or t in seen:
            continue
        seen.add(t)
        targets.append(t)
    if not targets:
        return None
    os.makedirs(CMPV_DIR, exist_ok=True)
    out = {
        "title": body.get("title") if isinstance(body.get("title"), str) else "未命名对比",
        "desc": body.get("desc") if isinstance(body.get("desc"), str) else "",
        "targets": targets,
    }
    p = os.path.join(CMPV_DIR, name + ".cmpv")
    tmp = p + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None
    return _dir_item(CMPV_DIR, CMPV_PREFIX, name + ".cmpv")


@app.route("/api/cmpv", methods=["POST"])
def api_cmpv_create():
    """新建一份对比视图：body { name, title?, desc?, targets:[...] }；同名已存在返回 409。"""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "请求体必须是对象"}), 400
    name = body.get("name")
    if not isinstance(name, str) or not CMPV_NAME_RE.match(name):
        return jsonify({"error": "name 只能是字母/数字/空格/下划线/短横线"}), 400
    if os.path.exists(os.path.join(CMPV_DIR, name + ".cmpv")):
        return jsonify({"error": f"{name}.cmpv 已存在"}), 409
    item = _cmpv_write(name, body)
    if not item:
        return jsonify({"error": "没有有效目标（targets 需为 content/ 下的 .json 路径）"}), 400
    return jsonify({"item": item})


@app.route("/api/cmpv/<path:name>", methods=["DELETE"])
def api_cmpv_delete(name):
    """删掉一份对比视图（只删 .cmpv 本身，不动被引用的 DSP 文件）。"""
    stem = name[:-5] if isinstance(name, str) and name.endswith(".cmpv") else name
    if not isinstance(stem, str) or not CMPV_NAME_RE.match(stem):
        return jsonify({"error": "文件名不合法"}), 400
    try:
        os.remove(os.path.join(CMPV_DIR, stem + ".cmpv"))
    except FileNotFoundError:
        return jsonify({"error": "这份对比已经不在了"}), 404
    except OSError as e:
        return jsonify({"error": f"删除失败：{e}"}), 500
    return jsonify({"ok": True, "name": stem})


# ---- 就地重命名：同目录改文件名（只允许 content/ 下的 .json / .cmpv） ----
NAME_STEM_RE = re.compile(r"^[A-Za-z0-9 _+.-]+$")      # 文件名主体（不含扩展名）


def _retarget_cmpv(old_rel, new_rel):
    """某个 DSP 改名后，把所有 .cmpv 里对它的引用一并改掉（否则对比视图立刻变成"缺失"）。"""
    try:
        names = [n for n in os.listdir(CMPV_DIR) if n.endswith(".cmpv")]
    except FileNotFoundError:
        return
    for n in names:
        p = os.path.join(CMPV_DIR, n)
        try:
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        targets = d.get("targets")
        if not isinstance(targets, list) or old_rel not in targets:
            continue
        d["targets"] = [new_rel if t == old_rel else t for t in targets]
        tmp = p + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, indent=2)
            os.replace(tmp, p)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass


@app.route("/api/rename", methods=["POST"])
def api_rename():
    """就地重命名：body { path, name }（name 带扩展名，同目录改名）。

    - 只认 content/ 下的 .json / .cmpv；目标已存在 → 409
    - 改 .json 时顺带把所有 .cmpv 里对它的引用改成新路径
    """
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "请求体必须是对象"}), 400
    old, name = body.get("path"), body.get("name")
    if not isinstance(old, str) or not isinstance(name, str):
        return jsonify({"error": "需要 path 与 name"}), 400
    old = old.replace("\\", "/")
    if ".." in old or "/" in name or "\\" in name or ".." in name:
        return jsonify({"error": "名字里不能有路径分隔符"}), 400
    if not old.startswith(CONTENT_PREFIX) or not old.endswith(ITEM_EXTS):
        return jsonify({"error": "只能改 content/ 下的 .json / .cmpv"}), 400
    if not name.endswith(ITEM_EXTS):
        return jsonify({"error": "扩展名必须是 .json 或 .cmpv"}), 400
    stem = name.rsplit(".", 1)[0]
    if not stem or stem.startswith(".") or not NAME_STEM_RE.match(stem):
        return jsonify({"error": "文件名只能用字母/数字/空格/下划线/短横线/点"}), 400
    base = os.path.abspath(CONTENT_DIR)
    src = os.path.abspath(os.path.join(HERE, *[s for s in old.split("/") if s]))
    if not src.startswith(base + os.sep):
        return jsonify({"error": "路径越界"}), 400
    if not os.path.isfile(src):
        return jsonify({"error": "源文件不存在"}), 404
    dst = os.path.join(os.path.dirname(src), name)
    if os.path.abspath(dst) != src and os.path.exists(dst):
        return jsonify({"error": f"{name} 已存在"}), 409
    try:
        os.replace(src, dst)
    except OSError as e:
        return jsonify({"error": f"重命名失败：{e}"}), 500
    dirpath, fname = os.path.split(dst)
    sub = os.path.relpath(dirpath, base).replace("\\", "/")
    prefix = CONTENT_PREFIX + ("" if sub == "." else sub + "/")
    new_rel = prefix + fname
    if old.endswith(".json") and new_rel != old:
        _retarget_cmpv(old, new_rel)                       # 修对比视图里的引用
    item = _dir_item(dirpath, prefix, fname)
    if not item:
        return jsonify({"error": "重命名后读取失败"}), 500
    return jsonify({"item": item, "old": old})


# ---- 画布快照：暂停时前端把画布 toDataURL 出的 PNG 交给后端落盘，恢复播放时删掉 ----
SHOT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.(?:png|json)$")   # .json = 与 PNG 配对的旁挂数据
MAX_SHOT_BYTES = 4 * 1024 * 1024     # 单张快照上限；超了拒绝写入（画布导出通常只有几十 KB）
MAX_SHOT_META_BYTES = 2 * 1024 * 1024  # 旁挂 JSON 上限（12×250 个浮点 ≈ 30KB，留足余量）


@app.route("/api/shots/<path:name>", methods=["GET", "POST", "DELETE"])
def api_shot(name):
    """content/Snapshots/<name> 的读 / 写 / 删；GET 直接返回 PNG 本体（前端 <img> 直接加载）。

    POST 体 = { data: 'data:image/png;base64,...', meta: {...} }：
      data 是 canvas.toDataURL 的原样输出；meta 可选 —— 给了就顺带写一份同名的
      <name>.json（画这张图用的数据 + 链 + 窗口参数），PNG 与它永远成对。
    落盘同样先写 .tmp 再改名：任何时候读到的都是完整的文件。
    """
    if not SHOT_NAME_RE.match(name or ""):
        return jsonify({"error": "快照文件名不合法"}), 400
    p = os.path.join(SHOT_DIR, name)
    side = os.path.join(SHOT_DIR, name[:-4] + ".json") if name.endswith(".png") else None
    if request.method == "GET":
        if not os.path.isfile(p):
            return jsonify({"error": "没有这张快照"}), 404
        mt = "image/png" if name.endswith(".png") else "application/json"
        return send_from_directory(SHOT_DIR, name, mimetype=mt)
    if request.method == "DELETE":
        # 删 PNG 时连旁挂 JSON 一起删（两半要成对）。JSON 删失败只记警告不报 500：
        # Windows 上刚 GET 完同一份文件，句柄可能还没释放（0x20 共享冲突），
        # 这时把 PNG 的删除结果一起判失败反而更糟 —— 孤儿 JSON 会在下次快照时被覆盖。
        def _rm(q):
            try:
                os.remove(q)
                return None
            except FileNotFoundError:
                return None
            except OSError as e:
                return str(e)

        err = _rm(p)
        if err:
            return jsonify({"error": f"删除失败：{err}"}), 500
        warn = _rm(side) if side else None
        return jsonify({"ok": True, "name": name, "metaRemoved": not warn, "warning": warn or ""})
    if not name.endswith(".png"):
        return jsonify({"error": "POST 只能写 .png"}), 400
    body = request.get_json(silent=True)
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, str) or not data.startswith("data:image/png;base64,"):
        return jsonify({"error": "请求体必须是 {data:'data:image/png;base64,...'}"}), 400
    try:
        raw = base64.b64decode(data.split(",", 1)[1])
    except (ValueError, binascii.Error):
        return jsonify({"error": "PNG base64 解码失败"}), 400
    if len(raw) > MAX_SHOT_BYTES:
        return jsonify({"error": "快照过大，拒绝写入"}), 413
    os.makedirs(SHOT_DIR, exist_ok=True)
    tmp = p + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(raw)
        os.replace(tmp, p)
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return jsonify({"error": f"写入失败：{e}"}), 500
    # 旁挂数据：PNG 是"看到的那张图"，这份 JSON 是"画出它的数据"（12 音级 × 250 列的 ring）
    meta = body.get("meta") if isinstance(body, dict) else None
    meta_name = None
    if isinstance(meta, dict):
        try:
            txt = json.dumps({"png": name, **meta}, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            txt = None
        if txt is not None and len(txt.encode("utf-8")) <= MAX_SHOT_META_BYTES:
            mtmp = side + ".tmp"
            try:
                with open(mtmp, "w", encoding="utf-8") as f:
                    f.write(txt)
                os.replace(mtmp, side)
                meta_name = name[:-4] + ".json"
            except OSError:
                try:
                    os.remove(mtmp)
                except OSError:
                    pass
    return jsonify({"ok": True, "file": SHOT_PREFIX + name, "url": "/api/shots/" + name,
                    "meta": (SHOT_PREFIX + meta_name) if meta_name else None})


@app.route("/api/templates")
def api_templates():
    """列出 content/Templates/ 下全部 .json（带 title/desc/stages，列表视图不必再逐个取）。"""
    return jsonify({"dir": TPL_PREFIX, "items": _dir_list(TPL_DIR, TPL_PREFIX)})


@app.route("/api/templates/<path:name>")
def api_template_one(name):
    """取单个模板文件（列表之外的新文件、或前端直接按路径打开时用）。"""
    item = _dir_item(TPL_DIR, TPL_PREFIX, name)
    if not item:
        return jsonify({"error": "模板不存在或不是合法 JSON"}), 404
    return jsonify({"item": item})


@app.route("/api/dsps")
def api_dsps():
    """列出 content/My dsps/ 下全部 .json（= 我的图）。首次调用会顺带做一次迁移。"""
    _dsp_migrate_once()
    return jsonify({"dir": DSP_PREFIX, "items": _dir_list(DSP_DIR, DSP_PREFIX)})


@app.route("/api/dsps/<path:name>")
def api_dsp_one(name):
    item = _dir_item(DSP_DIR, DSP_PREFIX, name)
    if not item:
        return jsonify({"error": "这一条不存在或不是合法 JSON"}), 404
    return jsonify({"item": item})


@app.route("/api/dsps", methods=["POST"])
def api_dsp_create():
    """新建一条我的图：name 即图的 id（untitled、untitled-2…），已存在返回 409。"""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "请求体必须是对象"}), 400
    name = body.get("name")
    if not isinstance(name, str) or not DSP_NAME_RE.match(name):
        return jsonify({"error": "name 只能是字母/数字/下划线/短横线（= 图的 id）"}), 400
    if os.path.exists(os.path.join(DSP_DIR, name + ".json")):
        return jsonify({"error": f"{name}.json 已存在"}), 409
    item = _dsp_write(name, body)
    if not item:
        return jsonify({"error": "写入失败"}), 500
    return jsonify({"item": item})


@app.route("/api/dsps/<path:name>", methods=["POST"])
def api_dsp_save(name):
    """覆盖写回某一条（标题 / 说明 / 级联）。"""
    if not _dsp_path(name):
        return jsonify({"error": "文件名不合法"}), 400
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "请求体必须是对象"}), 400
    item = _dsp_write(name, body)
    if not item:
        return jsonify({"error": "写入失败"}), 500
    return jsonify({"item": item})


@app.route("/api/dsps/<path:name>", methods=["DELETE"])
def api_dsp_delete(name):
    p = _dsp_path(name)
    if not p:
        return jsonify({"error": "文件名不合法"}), 400
    try:
        os.remove(p)
    except FileNotFoundError:
        return jsonify({"error": "这一条已经不在了"}), 404
    except OSError as e:
        return jsonify({"error": f"删除失败：{e}"}), 500
    return jsonify({"ok": True, "name": name})


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

"""生成两段测试音频：breath.wav（2–4.5 秒「哈——」送气噪声）、speech.wav（同一时段有音高的说话声）。
用法：/opt/homebrew/bin/python3.11 scripts/make-test-audio.py shots/"""
import sys, wave
import numpy as np

out = sys.argv[1] if len(sys.argv) > 1 else 'shots/'
sr = 48000
n = int(sr * 8.0)
t = np.arange(n) / sr
rng = np.random.default_rng(1)
room = rng.normal(0, 0.002, n)


def write(name, x):
    x = np.clip(x, -1, 1)
    w = wave.open(out + name, 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes((x * 32767).astype('<i2').tobytes()); w.close()


def env(a, b):
    e = ((t >= a) & (t < b)).astype(float)
    k = int(sr * 0.05)
    return np.convolve(e, np.ones(k) / k, 'same')


w = rng.normal(0, 1, n)
F = np.fft.rfft(w)
f = np.fft.rfftfreq(n, 1 / sr)
F *= np.exp(-((np.log(f + 1) - np.log(1400)) ** 2) / (2 * 0.7 ** 2))
br = np.fft.irfft(F, n)
br /= np.abs(br).max()
write('breath.wav', room + 0.25 * br * env(2.0, 4.5))

sp = np.zeros(n)
ph = 2 * np.pi * np.cumsum(140 * (1 + 0.05 * np.sin(2 * np.pi * 3 * t))) / sr
for h in range(1, 30):
    fr = 140 * h
    amp = np.exp(-((fr - 700) ** 2) / (2 * 300 ** 2)) + 0.6 * np.exp(-((fr - 1200) ** 2) / (2 * 250 ** 2)) + 0.3 * np.exp(-((fr - 2500) ** 2) / (2 * 400 ** 2))
    sp += amp * np.sin(h * ph)
syl = (np.sin(2 * np.pi * 4 * t) > 0.1).astype(float)
syl = np.convolve(syl, np.ones(int(sr * 0.02)) / int(sr * 0.02), 'same')
write('speech.wav', room + 0.3 * sp / np.abs(sp).max() * syl * env(2.0, 4.5))
print('wrote', out + 'breath.wav', out + 'speech.wav')

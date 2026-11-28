"""Track engine firing frequency (f0) over time with subharmonic summation + Viterbi smoothing."""
import sys, json, numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy.io import wavfile
from scipy.signal import stft

HOP = 256


def load(name):
    sr, x = wavfile.read(f'/home/claude/snd/wav/{name}.wav')
    return sr, x.astype(np.float32) / 32768


def track(x, sr, lo, hi, nh=10, n=8192):
    f, t, Z = stft(x, sr, nperseg=n, noverlap=n - HOP)
    M = np.log(np.abs(Z) + 1e-5)
    M -= np.median(M, axis=0, keepdims=True)
    cands = np.geomspace(lo, hi, 300)
    df = f[1]
    score = np.zeros((len(cands), M.shape[1]))
    for k in range(1, nh + 1):
        idx = cands * k / df
        i0 = np.clip(idx.astype(int), 0, len(f) - 2); a = (idx - i0)[:, None]
        v = M[i0] * (1 - a) + M[i0 + 1] * a
        # half-harmonic penalty keeps it from locking an octave low
        idh = cands * (k - 0.5) / df
        h0 = np.clip(idh.astype(int), 0, len(f) - 2)
        score += (v - 0.5 * M[h0]) / k ** 0.3
    # Viterbi: penalise jumps in log-frequency
    L = np.log(cands)
    trans = -((L[:, None] - L[None, :]) / 0.04) ** 2
    D = score[:, 0].copy(); back = np.zeros(score.shape, int)
    for j in range(1, score.shape[1]):
        tot = D[None, :] + trans
        back[:, j] = tot.argmax(1); D = tot.max(1) + score[:, j]
    path = np.zeros(score.shape[1], int); path[-1] = D.argmax()
    for j in range(score.shape[1] - 1, 0, -1): path[j - 1] = back[path[j], j]
    conf = score[path, np.arange(score.shape[1])]
    return t, cands[path], conf


if __name__ == '__main__':
    name, lo, hi = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    sr, x = load(name)
    t, f0, conf = track(x, sr, lo, hi)
    np.save(f'/home/claude/snd/{name}_f0.npy', np.stack([t, f0, conf]))
    fig, ax = plt.subplots(2, 1, figsize=(16, 6), sharex=True)
    ax[0].plot(t, f0); ax[0].grid(True); ax[0].set_ylabel('f0 Hz'); ax[0].set_title(name)
    ax[1].plot(t, conf); ax[1].grid(True)
    ax[1].set_xticks(np.arange(0, t[-1], 0.5)); plt.xticks(fontsize=7)
    plt.tight_layout(); plt.savefig(f'/home/claude/snd/png/{name}_f0.png', dpi=60)

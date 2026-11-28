"""Offline render of the runtime mixing logic for QA: idle -> full throttle sweep -> lift off -> idle."""
import json, sys, numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy.io import wavfile

A = '/home/claude/tallinna-soit/public/audio'
man = json.load(open(f'{A}/audio.json'))
REDLINE = {'rally': 7900, 'touring': 6500, 'coupe': 7250}


def render(cid):
    e = man['engines'][cid]
    sr, buf = wavfile.read(f'{A}/engine-{cid}.wav'); buf = buf.astype(np.float64) / 32768
    loops = e['loops']
    g = np.log(e['fTop'] * 1.25 / e['fIdle']) / np.log(REDLINE[cid] / 900)
    sets = {k: sorted([l for l in loops if l['kind'] in (k, 'idle')], key=lambda l: l['f']) for k in ('on', 'off')}
    B = 256; T = 9.0; nb = int(T * sr / B)
    out = np.zeros(nb * B)
    ph = {id(l): 0.0 for l in loops}
    gains = {id(l): 0.0 for l in loops}
    rpms = []
    for k in range(nb):
        t = k * B / sr
        if t < 1: rpm, thr = 900, 0
        elif t < 5: rpm, thr = 900 + (REDLINE[cid] - 900) * (t - 1) / 4, 1
        else: rpm, thr = max(900, REDLINE[cid] - (REDLINE[cid] - 900) * (t - 5) / 3), 0
        rpms.append(rpm)
        fT = e['fIdle'] * (rpm / 900) ** g
        for kind, L in sets.items():
            sg = np.sqrt(thr) if kind == 'on' else np.sqrt(1 - thr)
            i = 0
            while i < len(L) - 2 and fT > L[i + 1]['f']: i += 1
            a = np.clip(np.log(fT / L[i]['f']) / np.log(L[i + 1]['f'] / L[i]['f']), 0, 1)
            for j, l in enumerate(L):
                w = (1 - a) if j == i else a if j == i + 1 else 0
                tgt = w * sg * (0.5 + 0.5 * thr)
                gid = id(l)
                g0 = gains[gid]; g1 = g0 + (tgt - g0) * (1 - np.exp(-B / sr / 0.04)); gains[gid] = g1
                rate = np.clip(fT / l['f'], 0.4, 2.6)
                pos = ph[gid] + np.arange(B) * rate
                idx = l['s'] + np.mod(pos, l['n'])
                i0 = idx.astype(int); fr = idx - i0
                s = buf[i0] * (1 - fr) + buf[np.minimum(i0 + 1, len(buf) - 1)] * fr
                if g0 or g1: out[k * B:(k + 1) * B] += s * np.linspace(g0, g1, B)
                ph[gid] = np.mod(ph[gid] + B * rate, l['n'])
    out /= np.abs(out).max()
    wavfile.write(f'/home/claude/snd/sim-{cid}.wav', sr, (out * 32767).astype(np.int16))
    from scipy.signal import spectrogram
    f, tt, S = spectrogram(out, sr, nperseg=2048, noverlap=2048 - 256)
    S = 10 * np.log10(S + 1e-12); m = f < 1500
    d = np.abs(np.diff(out)); print(cid, 'max sample jump', round(d.max(), 3), '99.99pct', round(np.percentile(d, 99.99), 3))
    plt.figure(figsize=(14, 4)); plt.pcolormesh(tt, f[m], S[m], shading='auto', vmin=S[m].max() - 60, cmap='magma'); plt.title(cid)
    plt.tight_layout(); plt.savefig(f'/home/claude/snd/png/sim-{cid}.png', dpi=60); plt.close()


for c in sys.argv[1:] or REDLINE: render(c)

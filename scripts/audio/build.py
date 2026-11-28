"""Cut YouTube engine recordings into pitch-flattened, seamless RPM loops per car,
plus one-shots (pops, crashes) and a tyre-squeal loop. Writes public/audio/*."""
import json, numpy as np
from scipy.io import wavfile
from scipy.signal import medfilt, butter, sosfiltfilt
from scipy.interpolate import CubicSpline

SR_IN = 44100
SR = 32000
OUT = '/home/claude/tallinna-soit/public/audio'
FILES = {
    'sub': '68d42c91', 'vbang': 'b5b486f9', 'vpipe': '54181d53', 'vcold': '316f164e', 'vstr': '4cbb112e',
    'bint': '2cc38e7a', 'bcmp': '80dd4a3d', 'crashA': 'ad74d053', 'crashB': 'd458d9e8', 'sub2': 'e3be203e', 'e30': '970e8c7d',
}
_cache = {}


def wav(key):
    if key not in _cache:
        sr, x = wavfile.read(f'/home/claude/snd/wav/{FILES[key]}.wav')
        x = x.astype(np.float64) / 32768
        sos = butter(4, 25, 'highpass', fs=sr, output='sos')  # rumble / DC
        _cache[key] = sosfiltfilt(sos, x)
    return _cache[key]


def f0_curve(key):
    t, f, c = np.load(f'/home/claude/snd/{FILES[key]}_f0.npy')
    f = medfilt(f, 9)
    n = len(wav(key))
    ts = np.arange(n) / SR_IN
    return np.interp(ts, t, f)


# (source, t0, t1, kind) hand-picked from the f0 plots: monotone or steady stretches only
CARS = {
    'rally': {
        'idle': ('sub2', 8.0, 11.0),
        'segs': [('sub2', 12.1, 12.95, 'on'), ('sub2', 15.4, 16.45, 'on'), ('sub2', 22.2, 23.0, 'on'), ('sub2', 36.4, 36.9, 'on'),
                 ('sub2', 39.3, 39.9, 'on'), ('sub2', 56.9, 57.25, 'on'),
                 ('sub2', 13.1, 15.0, 'off'), ('sub2', 16.6, 18.5, 'off'), ('sub2', 57.4, 59.8, 'off'), ('sub2', 61.2, 62.8, 'off'),
                 ('sub2', 37.0, 38.2, 'off')],
    },
    'touring': {
        'idle': ('vstr', 20.0, 32.0),
        'segs': [('vbang', 1.0, 5.4, 'on'), ('vbang', 7.2, 10.8, 'on'), 
                 ('vpipe', 1.0, 1.75, 'on'), ('vpipe', 2.2, 2.95, 'on'), ('vpipe', 3.8, 4.6, 'on'),
                 ('vstr', 4.4, 4.65, 'on'), ('vstr', 7.9, 8.1, 'on'),
                 ('vpipe', 5.15, 6.7, 'off'), ('vstr', 4.7, 5.4, 'off'), ('vstr', 8.2, 9.3, 'off'),
                 ('vcold', 5.0, 6.5, 'off'), ('vcold', 1.5, 2.3, 'off'), ('vbang', 0.1, 0.9, 'off')],
    },
    'coupe': {
        'idle': ('e30', 231.2, 233.0),
        'segs': [('e30', 199.5, 205.2, 'on'), ('e30', 207.2, 210.4, 'on'), ('e30', 211.6, 215.4, 'on'),
                 ('e30', 215.6, 221.0, 'off'), ('e30', 222.2, 230.0, 'off'), ('e30', 205.3, 206.8, 'off')],
    },
}


def warp(x, f, fT, ncyc):
    """Resample x so its firing frequency f(t) becomes constant fT; return ncyc+xfade cycles worth."""
    phase = np.concatenate([[0], np.cumsum(f[:-1])]) / SR_IN  # cycles
    L = int(round(ncyc * SR / fT))
    fT = ncyc * SR / L
    X = int(L * 0.25)
    tau = np.arange(L + X) * fT / SR  # target phase in cycles
    if tau[-1] > phase[-1]: return None, None
    tin = np.interp(tau, phase, np.arange(len(x)))
    y = CubicSpline(np.arange(len(x)), x)(tin)
    # seamless loop: blend the tail (which is phase-aligned with the start) into the head
    w = np.sin(np.linspace(0, np.pi / 2, X)) ** 2
    loop = y[:L].copy()
    loop[:X] = y[:X] * w + y[L:L + X] * (1 - w)
    return loop, fT


def best_window(f, lo, hi, minlen):
    ok = (f >= lo) & (f <= hi)
    best = None; i = 0; n = len(ok)
    while i < n:
        if ok[i]:
            j = i
            while j < n and ok[j]: j += 1
            if best is None or j - i > best[1] - best[0]: best = (i, j)
            i = j
        else: i += 1
    return best if best and best[1] - best[0] >= minlen else None


def spiky(y):
    sos = butter(4, 3000, 'highpass', fs=SR_IN, output='sos')
    e = np.convolve(np.abs(sosfiltfilt(sos, y)), np.ones(220) / 220, 'same')
    return e.max() / (np.median(e) + 1e-9)


def rms(y): return np.sqrt(np.mean(y ** 2)) + 1e-9


def build_car(cid, cfg):
    loops = []
    src, a, b = cfg['idle']
    x = wav(src); f = f0_curve(src)
    i0, i1 = int(a * SR_IN), int(b * SR_IN)
    fI = float(np.median(f[i0:i1]))
    # idle: long loop (many cycles) for natural irregularity
    nc = int(min(2.0, (b - a) * 0.7) * fI)
    y, fT = warp(x[i0:i1], f[i0:i1], fI, nc)
    loops.append(dict(kind='idle', f=fT, y=y))
    fmax = max(float(np.percentile(f0_curve(s)[int(t0 * SR_IN):int(t1 * SR_IN)], 95)) for s, t0, t1, k in cfg['segs'])
    grid = []
    g = fI * 1.22
    while g < fmax * 1.02: grid.append(g); g *= 1.22
    for kind in ('on', 'off'):
        for fT in grid:
            cands = []
            for s, t0, t1, k in cfg['segs']:
                if k != kind: continue
                x = wav(s); f = f0_curve(s)
                i0, i1 = int(t0 * SR_IN), int(t1 * SR_IN)
                for tol in (1.12, 1.22):
                    w = best_window(f[i0:i1], fT / tol, fT * tol, int(SR_IN * 6 / fT))
                    if w:
                        j0, j1 = i0 + w[0], i0 + w[1]
                        cyc = np.sum(f[j0:j1]) / SR_IN
                        clean = 1.0 if spiky(x[j0:j1]) < 4.0 else 0.15
                        cands.append((cyc / tol * clean, s, j0, j1, cyc))
                        break
            if not cands: continue
            _, s, j0, j1, cyc = max(cands)
            x = wav(s); f = f0_curve(s)
            nc = int(min(cyc * 0.78, fT * 0.9))
            if nc < 5: continue
            y, fo = warp(x[j0:j1], f[j0:j1], fT, nc)
            if y is None: continue
            loops.append(dict(kind=kind, f=fo, y=y))
    # loudness-normalise loops; keep on/off relative difference small (runtime does throttle gain)
    for L in loops: L['y'] = L['y'] / rms(L['y']) * 0.16
    pad = np.zeros(int(SR * 0.02))
    buf, meta, pos = [], [], 0
    for L in loops:
        buf += [L['y'], pad]
        meta.append(dict(kind=L['kind'], f=round(L['f'], 3), s=pos, n=len(L['y'])))
        pos += len(L['y']) + len(pad)
    out = np.concatenate(buf)
    out = np.clip(out / max(1, np.abs(out).max() / 0.98), -1, 1)
    wavfile.write(f'{OUT}/engine-{cid}.wav', SR, (out * 32767).astype(np.int16))
    return dict(sr=SR, fIdle=round(fI, 3), fTop=round(fmax, 3), loops=meta)


def fade(y, a=0.004, b=0.08):
    na, nb = int(SR * a), int(SR * b)
    y = y.copy(); y[:na] *= np.linspace(0, 1, na); y[-nb:] *= np.linspace(1, 0, nb) ** 2
    return y


def resample(x):
    return np.interp(np.arange(0, len(x) * SR / SR_IN) * SR_IN / SR, np.arange(len(x)), x)


def cut(key, a, b): return resample(wav(key)[int(a * SR_IN):int(b * SR_IN)])


def write(name, y, peak=0.9):
    y = y / (np.abs(y).max() + 1e-9) * peak
    wavfile.write(f'{OUT}/{name}.wav', SR, (y * 32767).astype(np.int16))


def onsets(key, a, b, n):
    x = wav(key)[int(a * SR_IN):int(b * SR_IN)]
    sos = butter(4, 2500, 'highpass', fs=SR_IN, output='sos')
    h = np.abs(sosfiltfilt(sos, x))
    e = np.convolve(h, np.ones(220) / 220, 'same')
    base = np.convolve(h, np.ones(8820) / 8820, 'same') + 1e-6
    r = e / base
    picks = []
    for i in np.argsort(r)[::-1]:
        if all(abs(i - p) > SR_IN * 0.25 for p in picks): picks.append(i)
        if len(picks) == n: break
    return [a + p / SR_IN for p in sorted(picks)]


if __name__ == '__main__':
    import os
    os.makedirs(OUT, exist_ok=True)
    man = {'engines': {cid: build_car(cid, cfg) for cid, cfg in CARS.items()}}
    # exhaust pops / bangs from the "lots of bangs" Volvo clip
    pts = onsets('vbang', 0.5, 25.0, 6)
    pops = []
    for i, t in enumerate(pts):
        write(f'pop{i}', fade(cut('vbang', t - 0.01, t + 0.28)), 0.9); pops.append(f'pop{i}.wav')
    man['pops'] = pops; man['popTimes'] = [round(t, 3) for t in pts]
    # tyre squeal loop (seamless by crossfade)
    s = cut('crashA', 0.85, 2.55)
    X = int(SR * 0.25); L = len(s) - X
    w = np.sin(np.linspace(0, np.pi / 2, X)) ** 2
    loop = s[:L].copy(); loop[:X] = s[:X] * w + s[L:] * (1 - w)
    write('skid', loop, 0.8)
    # crashes
    write('crash0', fade(cut('crashA', 2.62, 4.7), 0.002, 0.4))
    write('crash1', fade(cut('crashB', 3.15, 5.25), 0.002, 0.4))
    write('bump0', fade(cut('crashA', 2.62, 2.95), 0.002, 0.12), 0.8)
    write('bump1', fade(cut('crashB', 3.15, 3.5), 0.002, 0.12), 0.8)
    json.dump(man, open(f'{OUT}/audio.json', 'w'), indent=1)
    for cid, e in man['engines'].items():
        print(cid, 'idle', e['fIdle'], 'top', e['fTop'], [(l['kind'], round(l['f'], 1), round(l['n'] / SR, 2)) for l in e['loops']])
    print('pops at', man['popTimes'])

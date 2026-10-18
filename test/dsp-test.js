// Offline checks for the pitch shifter DSP. Run with any Node.js:
//   node test/dsp-test.js
const { PitchShifter, FFT } = require('../src/pitch-worklet.js');

const SR = 48000;
const BLOCK = 128;

function run(shifter, L, R, semitoneAt) {
  const n = L.length;
  const oL = new Float32Array(n);
  const oR = new Float32Array(n);
  for (let i = 0; i < n; i += BLOCK) {
    if (semitoneAt) {
      const st = semitoneAt(i);
      if (st !== undefined) shifter.setRatio(Math.pow(2, st / 12));
    }
    const end = Math.min(n, i + BLOCK);
    shifter.process(L.subarray(i, end), R.subarray(i, end), oL.subarray(i, end), oR.subarray(i, end));
  }
  return [oL, oR];
}

function tone(freqs, seconds, amps) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  freqs.forEach((f, idx) => {
    const a = amps ? amps[idx] : 1 / freqs.length;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / SR);
  });
  return x;
}

// Magnitude spectrum of a segment with Blackman-Harris window (size 65536).
function spectrum(x, start) {
  const N = 65536;
  const fft = new FFT(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.35875 - 0.48829 * Math.cos((2 * Math.PI * i) / N) + 0.14128 * Math.cos((4 * Math.PI * i) / N) - 0.01168 * Math.cos((6 * Math.PI * i) / N);
    re[i] = x[start + i] * w;
  }
  fft.transform(re, im, false);
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return { mag, binHz: SR / N };
}

function peakFreq(spec, lo, hi) {
  const { mag, binHz } = spec;
  let best = Math.round(lo / binHz);
  for (let k = best; k <= Math.round(hi / binHz); k++) if (mag[k] > mag[best]) best = k;
  const a = Math.log(mag[best - 1] + 1e-30), b = Math.log(mag[best] + 1e-30), c = Math.log(mag[best + 1] + 1e-30);
  const d = (0.5 * (a - c)) / (a - 2 * b + c);
  return (best + d) * binHz;
}

// Energy within +-width Hz of the given frequencies vs the rest (dB).
function purity(spec, freqs, width) {
  const { mag, binHz } = spec;
  let inside = 0, total = 0;
  for (let k = 1; k < mag.length; k++) {
    const e = mag[k] * mag[k];
    total += e;
    const f = k * binHz;
    if (freqs.some((t) => Math.abs(f - t) <= width)) inside += e;
  }
  return 10 * Math.log10(inside / Math.max(1e-30, total - inside));
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`);
  if (!ok) failures++;
}

for (const fftSize of [4096, 2048]) {
  const overlap = 8;
  console.log(`\n== fftSize ${fftSize}, overlap ${overlap} (latency ${(fftSize / SR * 1000).toFixed(1)} ms) ==`);

  // 1. Identity at 0 semitones: exact delayed copy.
  {
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.01) * 0.5 + (Math.random() - 0.5) * 0.3;
    const s = new PitchShifter(fftSize, overlap, SR);
    const [o] = run(s, x, x);
    let err = 0;
    for (let i = fftSize * 2; i < x.length; i++) err = Math.max(err, Math.abs(o[i] - x[i - fftSize]));
    check('identity at 0 st', err < 1e-4, `max err ${err.toExponential(2)}`);
  }

  // 2. Sine shifts.
  for (const st of [1, 3, -4, 7, -12, 12]) {
    const f0 = 440;
    const x = tone([f0], 3);
    const s = new PitchShifter(fftSize, overlap, SR);
    s.setRatio(Math.pow(2, st / 12));
    const [o] = run(s, x, x);
    const spec = spectrum(o, SR);
    const target = f0 * Math.pow(2, st / 12);
    const f = peakFreq(spec, target * 0.9, target * 1.1);
    const cents = 1200 * Math.log2(f / target);
    const pur = purity(spec, [target], 4);
    check(`sine 440 ${st > 0 ? '+' : ''}${st} st`, Math.abs(cents) < 2 && pur > 30, `got ${f.toFixed(2)} Hz (target ${target.toFixed(2)}, ${cents.toFixed(2)} cents), S/N ${pur.toFixed(1)} dB`);
  }

  // 3. Harmonic tone (220 Hz, 12 harmonics) shifted -5 and +2.
  for (const st of [-5, 2]) {
    const f0 = 220;
    const fs = [], as = [];
    for (let h = 1; h <= 12; h++) { fs.push(f0 * h); as.push(0.3 / h); }
    const x = tone(fs, 3, as);
    const s = new PitchShifter(fftSize, overlap, SR);
    s.setRatio(Math.pow(2, st / 12));
    const [o] = run(s, x, x);
    const spec = spectrum(o, SR);
    const r = Math.pow(2, st / 12);
    const targets = fs.map((f) => f * r);
    const pur = purity(spec, targets, 5);
    const f1 = peakFreq(spec, targets[0] * 0.95, targets[0] * 1.05);
    check(`harmonic 220 ${st > 0 ? '+' : ''}${st} st`, pur > 20, `fundamental ${f1.toFixed(2)} Hz (target ${targets[0].toFixed(2)}), S/N ${pur.toFixed(1)} dB`);
  }

  // 4. Amplitude stability of a shifted sine (no tremolo).
  {
    const x = tone([330], 3).map((v) => v * 0.5);
    const s = new PitchShifter(fftSize, overlap, SR);
    s.setRatio(Math.pow(2, 2 / 12));
    const [o] = run(s, x, x);
    const win = 2400;
    let lo = Infinity, hi = 0;
    for (let i = SR; i + win < o.length; i += win) {
      let e = 0;
      for (let j = 0; j < win; j++) e += o[i + j] * o[i + j];
      const rms = Math.sqrt(e / win);
      lo = Math.min(lo, rms); hi = Math.max(hi, rms);
    }
    const ripple = 20 * Math.log10(hi / lo);
    check('amplitude ripple', ripple < 0.5, `${ripple.toFixed(3)} dB, rms ${hi.toFixed(4)} (input ${(0.5 / Math.SQRT2).toFixed(4)})`);
  }

  // 5. Stereo separation: signal only in L stays in L.
  {
    const x = tone([500], 2);
    const z = new Float32Array(x.length);
    const s = new PitchShifter(fftSize, overlap, SR);
    s.setRatio(Math.pow(2, 3 / 12));
    const [oL, oR] = run(s, x, z);
    let eL = 0, eR = 0;
    for (let i = SR / 2; i < x.length; i++) { eL += oL[i] * oL[i]; eR += oR[i] * oR[i]; }
    const sep = 10 * Math.log10(eL / Math.max(eR, 1e-30));
    check('stereo separation', sep > 60, `${sep.toFixed(1)} dB`);
  }

  // 6. Live semitone changes: no NaN, no blow-up.
  {
    const x = tone([262, 330, 392], 4);
    const s = new PitchShifter(fftSize, overlap, SR);
    const seq = [0, 2, 5, -3, 0, -12, 12, 1];
    const [o] = run(s, x, x, (i) => (i % (SR / 2) === 0 ? seq[(i / (SR / 2)) | 0] : undefined));
    let peak = 0, bad = false;
    for (const v of o) { if (!Number.isFinite(v)) bad = true; peak = Math.max(peak, Math.abs(v)); }
    check('live changes stable', !bad && peak < 1.5, `peak ${peak.toFixed(3)}`);
  }

  // 7. Speed: 10 s of stereo audio.
  {
    const n = SR * 10;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.random() - 0.5;
    const s = new PitchShifter(fftSize, overlap, SR);
    s.setRatio(Math.pow(2, 3 / 12));
    const t0 = Date.now();
    run(s, x, x);
    const ms = Date.now() - t0;
    check('real-time factor', ms < 2000, `${ms} ms for 10 s of audio (${(ms / 100).toFixed(1)}% of one core)`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;

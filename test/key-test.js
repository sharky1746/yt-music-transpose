// Offline checks for key detection on synthetic chord progressions.
//   node test/key-test.js
const { FFT } = require('../src/pitch-worklet.js');
const { KeyDetector, keyName } = require('../src/key-detect.js');

const SR = 48000;
const FFT_SIZE = 16384;

// Chord tones (semitones above tonic) for typical progressions.
const PROGRESSIONS = {
  major: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], // I V vi IV
  minor: [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7]], // i iv V i
};

function render(tonic, mode, seconds, detune) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const prog = PROGRESSIONS[mode];
  const chordLen = Math.round(2 * SR);
  const base = 48 + tonic; // C3 + tonic
  for (let i = 0; i < n; i += chordLen) {
    const chord = prog[(i / chordLen) % prog.length];
    const notes = chord.map((s) => base + s).concat([base + chord[0] - 12]); // + bass
    for (const note of notes) {
      const f0 = 440 * Math.pow(2, (note - 69 + detune) / 12);
      for (let h = 1; h <= 6; h++) {
        const f = f0 * h;
        if (f > SR / 2) break;
        const a = 0.08 / h;
        for (let j = i; j < Math.min(n, i + chordLen); j++) x[j] += a * Math.sin((2 * Math.PI * f * j) / SR);
      }
    }
  }
  for (let i = 0; i < n; i++) x[i] += (Math.random() - 0.5) * 0.01; // light noise
  return x;
}

// Mimic AnalyserNode: Blackman window, dB of |X|/N.
const fft = new FFT(FFT_SIZE);
const win = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE) + 0.08 * Math.cos((4 * Math.PI * i) / FFT_SIZE);
function analyserFrame(x, start) {
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) re[i] = x[start + i] * win[i];
  fft.transform(re, im, false);
  const db = new Float32Array(FFT_SIZE / 2);
  for (let k = 0; k < FFT_SIZE / 2; k++) db[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / FFT_SIZE + 1e-12);
  return db;
}

let correct = 0, total = 0;
for (const detune of [0, 0.3]) {
  for (const mode of ['major', 'minor']) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const x = render(tonic, mode, 16, detune);
      const det = new KeyDetector(SR, FFT_SIZE);
      const hop = SR / 10;
      for (let s = 0; s + FFT_SIZE < x.length; s += hop) det.addFrame(analyserFrame(x, s), 0.1);
      const est = det.estimate();
      const ok = est && est.tonic === tonic && est.mode === mode;
      total++;
      if (ok) correct++;
      else console.log(`MISS  ${keyName(tonic, mode)} (detune ${detune}) -> ${est ? est.name : 'none'} (runner-up ${est && est.runnerUp})`);
    }
  }
}
console.log(`key detection: ${correct}/${total} correct`);
process.exitCode = correct / total >= 0.9 ? 0 : 1;

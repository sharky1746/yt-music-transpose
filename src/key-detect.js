/*
 * Musical key estimation from AnalyserNode spectra.
 *
 *  - Each frame: pick spectral peaks between ~55 Hz and ~2 kHz, map them to
 *    pitch classes (with a running tuning-offset estimate), compress
 *    loudness and accumulate a 12-bin chroma vector over the whole track.
 *  - The accumulated chroma (plus a separate bass chroma) is correlated with key
 *    profiles rotated to all 24 major/minor keys; the best match wins.
 *
 * Shared by the content script (global YTTKeyDetect) and Node tests.
 */
(() => {
  // Temperley (Kostka-Payne) key profiles, with the overtone energy each
  // scale degree adds to other pitch classes folded in (Gomez 2006), so they
  // match audio chroma rather than symbolic note counts.
  const BASE_PROFILES = {
    major: [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4],
    minor: [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33],
  };
  function withOvertones(p, decay, count) {
    const out = new Array(12).fill(0);
    for (let n = 0; n < 12; n++) {
      for (let h = 1; h <= count; h++) out[(n + Math.round(12 * Math.log2(h))) % 12] += p[n] * Math.pow(decay, h - 1);
    }
    return out;
  }
  const PROFILES = {
    major: withOvertones(BASE_PROFILES.major, 0.6, 4),
    minor: withOvertones(BASE_PROFILES.minor, 0.6, 4),
  };
  const BASS_WEIGHT = 0.5;

  const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F#', 'G', 'A♭', 'A', 'B♭', 'B'];
  const MINOR_NAMES = ['C', 'C#', 'D', 'E♭', 'E', 'F', 'F#', 'G', 'G#', 'A', 'B♭', 'B'];

  function keyName(tonic, mode) {
    const pc = ((tonic % 12) + 12) % 12;
    return mode === 'minor' ? `${MINOR_NAMES[pc]} 마이너` : `${MAJOR_NAMES[pc]} 메이저`;
  }

  // Relative major/minor share a key signature and are the most common
  // confusion, so the UI shows both.
  function relativeKeyName(tonic, mode) {
    return mode === 'minor' ? keyName(tonic + 3, 'major') : keyName(tonic + 9, 'minor');
  }

  function pearson(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }

  class KeyDetector {
    constructor(sampleRate, fftSize) {
      this.binHz = sampleRate / fftSize;
      this.lo = Math.max(2, Math.floor(55 / this.binHz));
      this.hi = Math.min(fftSize / 2 - 2, Math.ceil(2100 / this.binHz));
      this.mag = new Float64Array(this.hi + 2);
      this.reset();
    }

    reset() {
      this.chroma = new Float64Array(12);
      this.bass = new Float64Array(12);
      this.frame = new Float64Array(12);
      this.frameBass = new Float64Array(12);
      this.tuneC = 0;
      this.tuneS = 0;
      this.seconds = 0;
    }

    tuning() {
      // Offset of the track's tuning from A440, in semitones (-0.5 .. 0.5).
      return this.tuneC === 0 && this.tuneS === 0 ? 0 : Math.atan2(this.tuneS, this.tuneC) / (2 * Math.PI);
    }

    // db: Float32Array from AnalyserNode.getFloatFrequencyData; dt: seconds since last frame.
    addFrame(db, dt) {
      const { lo, hi, mag, frame, binHz } = this;
      let max = 0;
      for (let k = lo - 1; k <= hi + 1; k++) {
        const m = Math.pow(10, db[k] / 20);
        mag[k] = m;
        if (m > max) max = m;
      }
      // Ignore silence (analyser floor is around -100 dB).
      if (max < 1e-4) return;

      frame.fill(0);
      const frameBass = this.frameBass;
      frameBass.fill(0);
      const tuning = this.tuning();
      const floor = max * 0.01;
      for (let k = lo; k <= hi; k++) {
        const m = mag[k];
        if (m < floor || m <= mag[k - 1] || m < mag[k + 1]) continue;
        // Parabolic interpolation on dB for the exact peak frequency.
        const a = db[k - 1], b = db[k], c = db[k + 1];
        const den = a - 2 * b + c;
        const d = den !== 0 ? (0.5 * (a - c)) / den : 0;
        const f = (k + d) * binHz;
        const midi = 69 + 12 * Math.log2(f / 440);
        const w = Math.log1p((100 * m) / max);

        const raw = midi - Math.round(midi);
        this.tuneC += w * Math.cos(2 * Math.PI * raw);
        this.tuneS += w * Math.sin(2 * Math.PI * raw);

        const tuned = midi - tuning;
        const nearest = Math.round(tuned);
        const dev = tuned - nearest;
        const pc = ((nearest % 12) + 12) % 12;
        const cw = Math.cos(Math.PI * dev);
        frame[pc] += w * cw * cw;
        if (f < 250) frameBass[pc] += w * cw * cw;
      }
      let sum = 0, bsum = 0;
      for (let i = 0; i < 12; i++) { sum += frame[i]; bsum += frameBass[i]; }
      if (sum <= 0) return;
      for (let i = 0; i < 12; i++) this.chroma[i] += frame[i] / sum;
      if (bsum > 0) for (let i = 0; i < 12; i++) this.bass[i] += frameBass[i] / bsum;
      this.seconds += dt;
    }

    // Returns null until enough audio has been heard.
    estimate(minSeconds = 8) {
      if (this.seconds < minSeconds) return null;
      const scores = [];
      for (const mode of ['major', 'minor']) {
        const p = PROFILES[mode];
        for (let tonic = 0; tonic < 12; tonic++) {
          const rotated = new Array(12);
          for (let i = 0; i < 12; i++) rotated[(i + tonic) % 12] = p[i];
          scores.push({ tonic, mode, r: pearson(this.chroma, rotated) + BASS_WEIGHT * pearson(this.bass, rotated) });
        }
      }
      scores.sort((x, y) => y.r - x.r);
      const best = scores[0];
      return {
        tonic: best.tonic,
        mode: best.mode,
        name: keyName(best.tonic, best.mode),
        score: best.r,
        margin: best.r - scores[1].r,
        runnerUp: keyName(scores[1].tonic, scores[1].mode),
        seconds: Math.round(this.seconds),
      };
    }
  }

  const api = { KeyDetector, keyName, relativeKeyName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.YTTKeyDetect = api;
})();

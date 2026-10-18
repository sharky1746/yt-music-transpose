/*
 * Pitch shifter AudioWorklet (tempo preserved).
 *
 * Algorithm: peak-locked phase vocoder pitch shifting
 * (Laroche & Dolson, "New phase-vocoder techniques for pitch-shifting,
 * harmonizing and other exotic effects", 1999).
 *
 *  - STFT with periodic Hann window, zero-phase framing (fftshift).
 *  - Each frame: find spectral peaks, split spectrum into regions of
 *    influence around each peak, move each region by an integer number
 *    of bins and rotate it by a phase that keeps the peak's phase coherent
 *    with its new (ratio * measured) frequency across frames.
 *  - Phase rotation is computed once from the combined L+R analysis and
 *    applied identically to both channels, so the stereo image is kept.
 *  - On detected transients, the phase of regions whose energy jumped is
 *    reset to the input phase, which keeps drum attacks sharp.
 *
 * Latency is exactly fftSize samples.
 */

class FFT {
  constructor(n) {
    this.n = n;
    const levels = Math.log2(n) | 0;
    if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.rev[i] = r;
    }
  }

  // In-place complex FFT. inverse=true computes the unnormalized inverse.
  transform(re, im, inverse) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = this.cos[t];
          const wi = sign * this.sin[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

const TWO_PI = 2 * Math.PI;

function wrapPhase(p) {
  return p - TWO_PI * Math.round(p / TWO_PI);
}

class PitchShifter {
  constructor(fftSize, overlap, sampleRate) {
    this.sampleRate = sampleRate;
    this.ratio = 1;
    this.transientReset = true;
    this.configure(fftSize, overlap);
  }

  configure(fftSize, overlap) {
    const N = fftSize;
    const H = N / overlap;
    const bins = N / 2 + 1;
    this.overlap = overlap;
    this.N = N;
    this.H = H;
    this.bins = bins;
    this.fft = new FFT(N);

    this.window = new Float64Array(N);
    for (let i = 0; i < N; i++) this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
    // Hann analysis * Hann synthesis overlap-adds to 0.375 * overlap.
    this.outScale = 1 / (N * 0.375 * overlap);

    this.inL = new Float32Array(N);
    this.inR = new Float32Array(N);
    this.accL = new Float32Array(N);
    this.accR = new Float32Array(N);
    this.outL = new Float32Array(H);
    this.outR = new Float32Array(H);
    this.pending = 0;

    this.re = new Float64Array(N);
    this.im = new Float64Array(N);

    this.xLr = new Float64Array(bins); this.xLi = new Float64Array(bins);
    this.xRr = new Float64Array(bins); this.xRi = new Float64Array(bins);
    this.yLr = new Float64Array(bins); this.yLi = new Float64Array(bins);
    this.yRr = new Float64Array(bins); this.yRi = new Float64Array(bins);

    this.mag = new Float64Array(bins);
    this.prevMag = new Float64Array(bins);
    this.phaseL = new Float64Array(bins);
    this.phaseR = new Float64Array(bins);
    this.prevPhaseL = new Float64Array(bins);
    this.prevPhaseR = new Float64Array(bins);
    this.theta = new Float64Array(bins);
    this.prevTheta = new Float64Array(bins);
    this.peaks = new Int32Array(bins);
    this.bounds = new Int32Array(bins + 1);
    this.prevOnsetFraction = 0;
    this.thetaIsZero = true;

    // Transient detection range: ~150 Hz .. ~16 kHz
    this.onsetLo = Math.max(2, Math.round((150 * N) / this.sampleRate));
    this.onsetHi = Math.min(bins - 3, Math.round((16000 * N) / this.sampleRate));
  }

  setRatio(r) {
    this.ratio = r;
  }

  // Process one block. inputs/outputs are arrays of Float32Array (L, R).
  process(inL, inR, outL, outR) {
    const H = this.H;
    const N = this.N;
    const len = outL.length;
    for (let i = 0; i < len; i++) {
      const pos = N - H + this.pending;
      this.inL[pos] = inL ? inL[i] : 0;
      this.inR[pos] = inR ? inR[i] : 0;
      outL[i] = this.outL[this.pending];
      outR[i] = this.outR[this.pending];
      this.pending++;
      if (this.pending === H) {
        this.pending = 0;
        this.processFrame();
        this.inL.copyWithin(0, H);
        this.inR.copyWithin(0, H);
      }
    }
  }

  processFrame() {
    const { N, H, bins, re, im, window } = this;
    const half = N / 2;

    // Pack L + jR, windowed, zero-phase (rotate by N/2).
    for (let n = 0; n < N; n++) {
      const j = (n + half) & (N - 1);
      re[j] = this.inL[n] * window[n];
      im[j] = this.inR[n] * window[n];
    }
    this.fft.transform(re, im, false);

    const { xLr, xLi, xRr, xRi, mag, phaseL, phaseR } = this;
    for (let k = 0; k < bins; k++) {
      const nk = (N - k) & (N - 1);
      const ar = re[k], ai = im[k], br = re[nk], bi = -im[nk];
      // L = (Z[k] + conj Z[N-k]) / 2,  R = (Z[k] - conj Z[N-k]) / 2j
      const lr = 0.5 * (ar + br), li = 0.5 * (ai + bi);
      const rr = 0.5 * (ai - bi), ri = -0.5 * (ar - br);
      xLr[k] = lr; xLi[k] = li; xRr[k] = rr; xRi[k] = ri;
      const mL = Math.hypot(lr, li);
      const mR = Math.hypot(rr, ri);
      mag[k] = mL + mR;
      phaseL[k] = Math.atan2(li, lr);
      phaseR[k] = Math.atan2(ri, rr);
    }

    const ratio = this.ratio;
    const { yLr, yLi, yRr, yRi, theta, prevTheta, prevMag, prevPhaseL, prevPhaseR } = this;

    if (ratio === 1 && this.thetaIsZero) {
      // Identity: copy spectrum straight through.
      yLr.set(xLr); yLi.set(xLi); yRr.set(xRr); yRi.set(xRi);
      prevTheta.fill(0);
    } else {
      this.shiftSpectrum(ratio);
    }

    // Book-keeping for next frame.
    prevPhaseL.set(phaseL);
    prevPhaseR.set(phaseR);
    prevMag.set(mag);
    if (ratio === 1) {
      // Back at original key: drop accumulated rotations (one-time phase reset)
      this.thetaIsZero = true;
      prevTheta.fill(0);
    } else {
      this.thetaIsZero = false;
      prevTheta.set(theta);
    }

    // Rebuild packed spectrum Z = YL + jYR with Hermitian symmetry per channel.
    yLi[0] = 0; yRi[0] = 0; yLi[half] = 0; yRi[half] = 0;
    for (let k = 0; k <= half; k++) {
      re[k] = yLr[k] - yRi[k];
      im[k] = yLi[k] + yRr[k];
      if (k > 0 && k < half) {
        const nk = N - k;
        // conj(YL) + j conj(YR)
        re[nk] = yLr[k] + yRi[k];
        im[nk] = -yLi[k] + yRr[k];
      }
    }
    this.fft.transform(re, im, true);

    const { accL, accR, outScale } = this;
    for (let n = 0; n < N; n++) {
      const j = (n + half) & (N - 1);
      const w = window[n] * outScale;
      accL[n] += re[j] * w;
      accR[n] += im[j] * w;
    }
    this.outL.set(accL.subarray(0, H));
    this.outR.set(accR.subarray(0, H));
    accL.copyWithin(0, H);
    accR.copyWithin(0, H);
    accL.fill(0, N - H);
    accR.fill(0, N - H);
  }

  shiftSpectrum(ratio) {
    const { N, H, bins, mag, prevMag, peaks, bounds, theta, prevTheta } = this;
    const { xLr, xLi, xRr, xRi, yLr, yLi, yRr, yRi } = this;
    const { phaseL, phaseR, prevPhaseL, prevPhaseR } = this;

    yLr.fill(0); yLi.fill(0); yRr.fill(0); yRi.fill(0);

    // Peak picking (local max over +-2 bins).
    let maxMag = 0;
    for (let k = 0; k < bins; k++) if (mag[k] > maxMag) maxMag = mag[k];
    const floor = maxMag * 1e-7;
    let np = 0;
    for (let k = 2; k < bins - 2; k++) {
      const m = mag[k];
      if (m > floor && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) {
        peaks[np++] = k;
      }
    }
    if (np === 0) {
      theta.fill(0);
      return;
    }

    // Region boundaries: lowest bin between neighbouring peaks.
    bounds[0] = 0;
    for (let i = 0; i < np - 1; i++) {
      let lo = peaks[i];
      let minK = lo;
      for (let k = lo + 1; k < peaks[i + 1]; k++) if (mag[k] < mag[minK]) minK = k;
      bounds[i + 1] = minK;
    }
    bounds[np] = bins;

    // Transient detection: fraction of bins rising by more than 3 dB.
    let rising = 0;
    let counted = 0;
    const onsetFloor = maxMag * 1e-4;
    for (let k = this.onsetLo; k < this.onsetHi; k++) {
      if (mag[k] < onsetFloor) continue;
      counted++;
      if (mag[k] > 1.4125 * prevMag[k]) rising++;
    }
    const fraction = counted > 0 ? rising / counted : 0;
    const transient = this.transientReset && fraction > 0.35 && this.prevOnsetFraction <= 0.35;
    this.prevOnsetFraction = fraction;

    const omegaScale = TWO_PI / N;
    for (let i = 0; i < np; i++) {
      const p = peaks[i];
      // Measured instantaneous frequency from the louder channel.
      const mL = Math.hypot(xLr[p], xLi[p]);
      const mR = Math.hypot(xRr[p], xRi[p]);
      const dphi = mL >= mR ? phaseL[p] - prevPhaseL[p] : phaseR[p] - prevPhaseR[p];
      const omegaBin = p * omegaScale;
      const omega = omegaBin + wrapPhase(dphi - omegaBin * H) / H;

      const shift = Math.round(((ratio - 1) * omega) / omegaScale);
      let th;
      if (transient && mag[p] > 2 * prevMag[p]) {
        th = 0;
      } else {
        th = wrapPhase(prevTheta[p] + (ratio - 1) * omega * H);
      }

      const c = Math.cos(th);
      const s = Math.sin(th);
      const start = bounds[i];
      const end = bounds[i + 1];
      for (let k = start; k < end; k++) {
        theta[k] = th;
        const t = k + shift;
        if (t < 0 || t >= bins) continue;
        const lr = xLr[k], li = xLi[k], rr = xRr[k], ri = xRi[k];
        yLr[t] += lr * c - li * s;
        yLi[t] += lr * s + li * c;
        yRr[t] += rr * c - ri * s;
        yRi[t] += rr * s + ri * c;
      }
    }
  }
}

if (typeof registerProcessor === 'function') {
  class PitchShiftProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = (options && options.processorOptions) || {};
      this.shifter = new PitchShifter(o.fftSize || 4096, o.overlap || 8, sampleRate);
      this.shifter.setRatio(Math.pow(2, (o.semitones || 0) / 12));
      this.port.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'semitones') {
          this.shifter.setRatio(Math.pow(2, d.value / 12));
        } else if (d.type === 'config') {
          const ratio = this.shifter.ratio;
          this.shifter.configure(d.fftSize, d.overlap || 8);
          this.shifter.setRatio(ratio);
        }
      };
    }

    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      if (!output || output.length === 0) return true;
      // Nothing connected (original key, bypassed): stay idle and start
      // from clean buffers when audio comes back.
      if (!input || input.length === 0) {
        for (const ch of output) ch.fill(0);
        this.idle = true;
        return true;
      }
      if (this.idle) {
        const ratio = this.shifter.ratio;
        this.shifter.configure(this.shifter.N, this.shifter.overlap);
        this.shifter.setRatio(ratio);
        this.idle = false;
      }
      const inL = input && input.length > 0 ? input[0] : null;
      const inR = input && input.length > 1 ? input[1] : inL;
      const outL = output[0];
      const outR = output.length > 1 ? output[1] : new Float32Array(outL.length);
      this.shifter.process(inL, inR, outL, outR);
      return true;
    }
  }
  registerProcessor('yt-transpose-pitch-shifter', PitchShiftProcessor);
}

if (typeof module !== 'undefined') module.exports = { PitchShifter, FFT };

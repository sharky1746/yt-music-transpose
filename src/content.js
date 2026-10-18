// Content script for music.youtube.com.
//
// Audio graph (built when playback starts):
//
//   <video> ─ source ─┬─ dry gain ─────────────────────▶ speakers   (original key, no delay)
//                     ├─ pitch shifter ─ wet gain ─────▶ speakers   (connected only while shifted)
//                     └─ analyser (original-key estimation)
//
// At 0 semitones the dry path plays the audio unchanged; changing the key
// crossfades to the pitch-shifted path.
(() => {
  const VERSION = 2;
  const DEFAULTS = { semitones: 0, quality: 'high' };
  const QUALITY = {
    high: { fftSize: 4096, overlap: 8 },
    standard: { fftSize: 2048, overlap: 8 },
  };
  const ANALYSER_FFT = 16384;
  const { KeyDetector, keyName, relativeKeyName } = globalThis.YTTKeyDetect;

  // This script can be injected again into a tab that already ran it
  // (extension install/update injects into open tabs). A media element can
  // be connected to Web Audio only once, so take over the previous
  // instance's graph when it was built by the same version.
  const prev = globalThis.__ytTranspose;
  if (prev && typeof prev.teardown === 'function') {
    try {
      prev.teardown();
    } catch (_) {
      /* previous instance may belong to an unloaded extension context */
    }
  }
  const adopt = prev && prev.version === VERSION && prev.ctx ? prev : null;

  const state = {
    version: VERSION,
    semitones: 0,
    quality: adopt ? adopt.quality : 'high',
    ctx: adopt ? adopt.ctx : null,
    node: adopt ? adopt.node : null,
    dry: adopt ? adopt.dry : null,
    wet: adopt ? adopt.wet : null,
    analyser: adopt ? adopt.analyser : null,
    detector: adopt ? adopt.detector : null,
    graphPromise: adopt ? Promise.resolve(adopt.ctx) : null,
    attached: adopt ? adopt.attached : new WeakSet(),
    sources: adopt ? adopt.sources : [],
    wetOn: adopt ? adopt.wetOn : false,
    fadeToken: 0,
    key: null,
    trackTitle: '',
    error: null,
    waitingForGesture: false,
    teardown: null,
  };
  // Lives in the extension's isolated world only (the page cannot see it);
  // handy for inspecting the audio graph from DevTools.
  globalThis.__ytTranspose = state;

  // ---------- audio graph ----------

  function buildGraph() {
    if (state.graphPromise) return state.graphPromise;
    state.graphPromise = (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(chrome.runtime.getURL('src/pitch-worklet.js'));
      const q = QUALITY[state.quality] || QUALITY.high;
      const node = new AudioWorkletNode(ctx, 'yt-transpose-pitch-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { fftSize: q.fftSize, overlap: q.overlap, semitones: state.semitones },
      });
      const dry = new GainNode(ctx, { gain: 1 });
      const wet = new GainNode(ctx, { gain: 0 });
      const analyser = new AnalyserNode(ctx, { fftSize: ANALYSER_FFT, smoothingTimeConstant: 0 });
      node.connect(wet).connect(ctx.destination);
      dry.connect(ctx.destination);
      ctx.addEventListener('statechange', () => {
        if (ctx.state !== 'running' && ctx.state !== 'closed') resumeContext();
      });
      Object.assign(state, { ctx, node, dry, wet, analyser, detector: new KeyDetector(ctx.sampleRate, ANALYSER_FFT) });
      return ctx;
    })().catch((e) => {
      state.error = '오디오 초기화 실패: 탭을 새로고침(F5)하세요';
      console.warn('[YT Music Transpose]', e);
      state.graphPromise = null;
      throw e;
    });
    return state.graphPromise;
  }

  async function resumeContext() {
    const ctx = state.ctx;
    if (!ctx || ctx.state === 'running') return true;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 500))]);
    } catch (_) {
      /* handled below */
    }
    if (ctx.state === 'running') return true;
    waitForGesture();
    return false;
  }

  // Chrome only lets an AudioContext start after a user gesture on the page.
  function waitForGesture() {
    if (state.waitingForGesture) return;
    state.waitingForGesture = true;
    if (state.semitones !== 0) showToast('페이지를 한 번 클릭하면 키 변경이 적용됩니다');
    const retry = () => {
      window.removeEventListener('pointerdown', retry, true);
      window.removeEventListener('keydown', retry, true);
      state.waitingForGesture = false;
      hook();
    };
    window.addEventListener('pointerdown', retry, true);
    window.addEventListener('keydown', retry, true);
  }

  function attach(media) {
    if (!state.ctx || state.ctx.state !== 'running' || state.attached.has(media)) return;
    try {
      const source = state.ctx.createMediaElementSource(media);
      source.connect(state.dry);
      source.connect(state.analyser);
      if (state.wetOn) source.connect(state.node);
      state.sources.push(source);
      state.attached.add(media);
      media.addEventListener('emptied', resetKey);
      state.error = null;
    } catch (e) {
      state.error = '영상 연결 실패: 탭을 새로고침(F5)하세요';
      console.warn('[YT Music Transpose]', e);
    }
  }

  function attachAll() {
    document.querySelectorAll('video, audio').forEach(attach);
  }

  // Build the graph and connect the page's media. Only connects once the
  // context is running; connecting to a suspended context would mute the page.
  async function hook() {
    try {
      await buildGraph();
    } catch (_) {
      return;
    }
    if (await resumeContext()) {
      attachAll();
      route();
    }
  }

  // Crossfade between the original (dry) and pitch-shifted (wet) paths.
  function route() {
    const { ctx, node, dry, wet } = state;
    if (!ctx || ctx.state !== 'running') return;
    const want = state.semitones !== 0;
    if (want === state.wetOn) return;
    const token = ++state.fadeToken;
    const t = ctx.currentTime;
    const ramp = (param, to, dur) => {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(to, t + dur);
    };
    if (want) {
      state.sources.forEach((s) => s.connect(node));
      const fade = (QUALITY[state.quality] || QUALITY.high).fftSize / ctx.sampleRate;
      ramp(wet.gain, 1, fade);
      ramp(dry.gain, 0, fade);
      state.wetOn = true;
    } else {
      ramp(wet.gain, 0, 0.06);
      ramp(dry.gain, 1, 0.06);
      state.wetOn = false;
      // Disconnect after the fade so the shifter goes idle (saves CPU).
      setTimeout(() => {
        if (token !== state.fadeToken) return;
        state.sources.forEach((s) => {
          try {
            s.disconnect(node);
          } catch (_) {
            /* not connected */
          }
        });
      }, 120);
    }
  }

  // The player can swap media elements during SPA navigation.
  const observer = new MutationObserver((mutations) => {
    if (!state.ctx) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') attach(n);
        else if (n.querySelector) n.querySelectorAll('video, audio').forEach(attach);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  const onPlay = (e) => {
    if (e.target instanceof HTMLMediaElement) hook();
  };
  document.addEventListener('play', onPlay, true);

  // ---------- original key estimation ----------

  const freqData = new Float32Array(ANALYSER_FFT / 2);
  let lastFrame = performance.now();
  let lastEstimate = 0;

  function resetKey() {
    if (state.detector) state.detector.reset();
    state.key = null;
  }

  function currentTitle() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    return md ? `${md.title}\u0000${md.artist}` : '';
  }

  const analysisTimer = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.5, (now - lastFrame) / 1000);
    lastFrame = now;
    const { ctx, analyser, detector } = state;
    if (!ctx || ctx.state !== 'running' || !detector) return;

    const title = currentTitle();
    if (title !== state.trackTitle) {
      state.trackTitle = title;
      resetKey();
    }
    const playing = state.sources.some((s) => s.mediaElement && !s.mediaElement.paused);
    if (!playing) return;

    analyser.getFloatFrequencyData(freqData);
    detector.addFrame(freqData, dt);
    if (now - lastEstimate > 1000) {
      lastEstimate = now;
      state.key = detector.estimate();
    }
  }, 100);

  function keyInfo() {
    const k = state.key;
    if (!k) return null;
    return {
      tonic: k.tonic,
      mode: k.mode,
      original: k.name,
      current: keyName(k.tonic + state.semitones, k.mode),
      currentRelative: relativeKeyName(k.tonic + state.semitones, k.mode),
      confident: k.margin >= 0.02 && k.seconds >= 20,
      seconds: k.seconds,
    };
  }

  // ---------- settings ----------

  function applySemitones(v, { notify }) {
    state.semitones = v;
    if (state.node) state.node.port.postMessage({ type: 'semitones', value: v });
    if (v !== 0 && !state.ctx) hook();
    else if (v !== 0 && state.ctx && state.ctx.state !== 'running') hook();
    else route();
    if (notify) {
      const k = keyInfo();
      const label = v === 0 ? '원래 키' : `키 ${v > 0 ? '+' : ''}${v}`;
      showToast(k ? `${label} · ${k.current}` : label);
    }
  }

  function applyQuality(q) {
    state.quality = QUALITY[q] ? q : 'high';
    if (state.node) {
      const c = QUALITY[state.quality];
      state.node.port.postMessage({ type: 'config', fftSize: c.fftSize, overlap: c.overlap });
    }
  }

  chrome.storage.local.get(DEFAULTS).then((s) => {
    const q = QUALITY[s.quality] ? s.quality : 'high';
    if (q !== state.quality) applyQuality(q);
    applySemitones(s.semitones, { notify: s.semitones !== 0 && Boolean(state.ctx) });
    // Injected into a tab that is already playing: start right away.
    if (document.querySelector('video, audio') && [...document.querySelectorAll('video, audio')].some((m) => !m.paused)) hook();
  });

  const onStorage = (changes, area) => {
    if (area !== 'local') return;
    if (changes.quality) applyQuality(changes.quality.newValue);
    if (changes.semitones) applySemitones(changes.semitones.newValue ?? 0, { notify: true });
  };
  chrome.storage.onChanged.addListener(onStorage);

  const onMessage = (msg, _sender, sendResponse) => {
    if (msg && msg.type === 'status') {
      const ctx = state.ctx;
      const q = QUALITY[state.quality];
      sendResponse({
        hooked: state.sources.length > 0 && ctx && ctx.state === 'running',
        shifting: state.wetOn,
        latencyMs: ctx
          ? Math.round(((state.wetOn ? q.fftSize / ctx.sampleRate : 0) + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000)
          : null,
        error: state.error,
        waitingForGesture: state.waitingForGesture,
        key: keyInfo(),
        analysedSeconds: state.detector ? Math.round(state.detector.seconds) : 0,
      });
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  state.teardown = () => {
    observer.disconnect();
    clearInterval(analysisTimer);
    document.removeEventListener('play', onPlay, true);
    state.sources.forEach((s) => s.mediaElement && s.mediaElement.removeEventListener('emptied', resetKey));
    if (toastHost) toastHost.remove();
    try {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) {
      /* extension context already gone */
    }
  };

  // ---------- on-page toast ----------

  let toastHost = null;
  let toastEl = null;
  let toastTimer = 0;

  function showToast(text) {
    if (!document.body) return;
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
      const shadow = toastHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        '.t{font:600 15px/1.2 Roboto,"Noto Sans KR",sans-serif;color:#fff;background:rgba(20,20,20,.88);' +
        'padding:10px 18px;border-radius:20px;box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .15s}' +
        '.t.on{opacity:1}';
      toastEl = document.createElement('div');
      toastEl.className = 't';
      shadow.append(style, toastEl);
    }
    if (!toastHost.isConnected) document.body.appendChild(toastHost);
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1600);
  }
})();

// Content script for music.youtube.com.
// Routes the page's <video> element(s) through a pitch-shifting AudioWorklet.
// Nothing is touched until the key is changed for the first time, so the
// page plays exactly as usual while the setting is 0.
(() => {
  const DEFAULTS = { semitones: 0, quality: 'high' };
  const QUALITY = {
    high: { fftSize: 4096, overlap: 8 },
    standard: { fftSize: 2048, overlap: 8 },
  };

  const state = {
    semitones: 0,
    quality: 'high',
    ctx: null,
    node: null,
    graphPromise: null,
    active: false, // true once the key has been changed on this page
    attached: new WeakSet(),
    attachedCount: 0,
    sources: [],
    error: null,
    waitingForGesture: false,
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
      node.connect(ctx.destination);
      ctx.addEventListener('statechange', () => {
        if (ctx.state !== 'running' && ctx.state !== 'closed') resumeContext();
      });
      state.ctx = ctx;
      state.node = node;
      return ctx;
    })().catch((e) => {
      state.error = `오디오 초기화 실패: ${e && e.message}`;
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
      /* ignored, handled below */
    }
    if (ctx.state === 'running') return true;
    waitForGesture();
    return false;
  }

  // Chrome only lets an AudioContext start after a user gesture on the page.
  function waitForGesture() {
    if (state.waitingForGesture) return;
    state.waitingForGesture = true;
    showToast('페이지를 한 번 클릭하면 키 변경이 적용됩니다');
    const retry = () => {
      window.removeEventListener('pointerdown', retry, true);
      window.removeEventListener('keydown', retry, true);
      state.waitingForGesture = false;
      activate();
    };
    window.addEventListener('pointerdown', retry, true);
    window.addEventListener('keydown', retry, true);
  }

  function attach(video) {
    if (!state.ctx || state.ctx.state !== 'running' || state.attached.has(video)) return;
    try {
      const source = state.ctx.createMediaElementSource(video);
      source.connect(state.node);
      state.sources.push(source);
      state.attached.add(video);
      state.attachedCount++;
      state.error = null;
    } catch (e) {
      state.error = `영상 요소 연결 실패: ${e && e.message}`;
    }
  }

  function attachAll() {
    document.querySelectorAll('video, audio').forEach(attach);
  }

  async function activate() {
    state.active = true;
    try {
      await buildGraph();
    } catch (_) {
      return;
    }
    // Only connect media once the context is running; connecting to a
    // suspended context would silence the page.
    if (await resumeContext()) attachAll();
  }

  // The player can swap media elements during SPA navigation.
  const observer = new MutationObserver((mutations) => {
    if (!state.active) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') attach(n);
        else if (n.querySelector) n.querySelectorAll('video, audio').forEach(attach);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  document.addEventListener(
    'play',
    (e) => {
      if (state.active && e.target instanceof HTMLMediaElement) attach(e.target);
    },
    true
  );

  // ---------- settings ----------

  function applySemitones(v, { notify }) {
    state.semitones = v;
    if (state.node) state.node.port.postMessage({ type: 'semitones', value: v });
    if (v !== 0 && !state.active) activate();
    if (notify) showToast(v === 0 ? '원래 키' : `키 ${v > 0 ? '+' : ''}${v}`);
  }

  function applyQuality(q) {
    state.quality = QUALITY[q] ? q : 'high';
    if (state.node) {
      const c = QUALITY[state.quality];
      state.node.port.postMessage({ type: 'config', fftSize: c.fftSize, overlap: c.overlap });
    }
  }

  chrome.storage.local.get(DEFAULTS).then((s) => {
    state.quality = QUALITY[s.quality] ? s.quality : 'high';
    applySemitones(s.semitones, { notify: s.semitones !== 0 });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.quality) applyQuality(changes.quality.newValue);
    if (changes.semitones) applySemitones(changes.semitones.newValue ?? 0, { notify: true });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'status') {
      const ctx = state.ctx;
      const q = QUALITY[state.quality];
      sendResponse({
        active: state.active,
        attached: state.attachedCount,
        contextState: ctx ? ctx.state : 'none',
        latencyMs: ctx
          ? Math.round((q.fftSize / ctx.sampleRate + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000)
          : null,
        error: state.error,
        waitingForGesture: state.waitingForGesture,
      });
    }
  });

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
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1400);
  }
})();

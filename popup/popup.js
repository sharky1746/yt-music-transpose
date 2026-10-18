import { MIN_SEMITONES, MAX_SEMITONES, clampSemitones, getSettings, setSemitones, formatSemitones, injectContentScript } from '../src/shared.js';

const $ = (id) => document.getElementById(id);
const valueEl = $('value');
const captionEl = $('caption');
const slider = $('slider');
const statusEl = $('status');
let current = 0;

function render(v) {
  current = v;
  valueEl.textContent = formatSemitones(v);
  valueEl.className = v > 0 ? 'up' : v < 0 ? 'down' : '';
  captionEl.textContent = v === 0 ? '원래 키' : `반음 ${Math.abs(v)}개 ${v > 0 ? '올림' : '내림'}`;
  slider.value = String(v);
  $('down').disabled = v <= MIN_SEMITONES;
  $('up').disabled = v >= MAX_SEMITONES;
}

// Values this popup wrote, so their (late) change events don't rewind the
// display while the user is still clicking.
const ownWrites = new Map();
let stored = 0;

async function change(v) {
  // Render synchronously so rapid clicks build on the latest value.
  render(clampSemitones(v));
  if (current === stored) return;
  stored = current;
  ownWrites.set(current, (ownWrites.get(current) || 0) + 1);
  await setSemitones(current);
  setTimeout(refreshStatus, 300);
}

$('down').addEventListener('click', () => change(current - 1));
$('up').addEventListener('click', () => change(current + 1));
$('reset').addEventListener('click', () => change(0));
slider.addEventListener('input', () => change(Number(slider.value)));
$('quality').addEventListener('change', (e) => chrome.storage.local.set({ quality: e.target.value }));
$('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

document.addEventListener('keydown', (e) => {
  if (e.target === slider) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); change(current + 1); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); change(current - 1); }
  else if (e.key === '0') change(0);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.semitones) return;
  const v = changes.semitones.newValue ?? 0;
  const n = ownWrites.get(v) || 0;
  if (n > 0) {
    if (n === 1) ownWrites.delete(v);
    else ownWrites.set(v, n - 1);
    return;
  }
  stored = v;
  render(v);
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls || ''}`;
}

async function refreshStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setStatus('');
  const isYtm = (tab.url || '').startsWith('https://music.youtube.com/');
  let s;
  try {
    s = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
  } catch (_) {
    if (!isYtm) return setStatus('YouTube Music 탭에서 사용하세요', 'warn');
    // Tab was open before the extension was installed: inject now.
    try {
      await injectContentScript(tab.id);
      await new Promise((r) => setTimeout(r, 400));
      s = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
    } catch (e) {
      return setStatus('탭을 새로고침(F5)하세요', 'warn');
    }
  }
  if (!s) return setStatus('');
  if (s.error) return setStatus(s.error, 'warn');
  if (s.waitingForGesture) return setStatus('페이지를 한 번 클릭하세요', 'warn');
  if (!s.active) return setStatus('대기 중 (키 변경 시 적용)');
  if (s.contextState === 'running' && s.attached > 0) return setStatus(`적용 중 · 지연 ${s.latencyMs}ms`, 'ok');
  return setStatus('재생을 시작하면 적용됩니다', 'warn');
}

(async () => {
  const s = await getSettings();
  stored = s.semitones;
  render(s.semitones);
  $('quality').value = s.quality;
  refreshStatus();
})();

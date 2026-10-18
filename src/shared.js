// Settings shared by background, popup and content script.
// (content.js keeps its own copy because content scripts cannot import modules.)
export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;
export const DEFAULTS = { semitones: 0, quality: 'high' };

export function clampSemitones(v) {
  const n = Math.round(Number(v) || 0);
  return Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, n));
}

export function formatSemitones(v) {
  return v > 0 ? `+${v}` : String(v);
}

export async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

// Chrome does not run content scripts in tabs that were already open when the
// extension was installed or updated, so inject it on demand.
export async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
}

export async function setSemitones(v) {
  const semitones = clampSemitones(v);
  await chrome.storage.local.set({ semitones });
  return semitones;
}

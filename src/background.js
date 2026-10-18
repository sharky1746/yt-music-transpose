import { getSettings, setSemitones, formatSemitones, injectContentScript } from './shared.js';

async function updateBadge(semitones) {
  await chrome.action.setBadgeText({ text: semitones === 0 ? '' : formatSemitones(semitones) });
  await chrome.action.setBadgeBackgroundColor({ color: semitones > 0 ? '#d93025' : '#1a73e8' });
}

chrome.commands.onCommand.addListener(async (command) => {
  const { semitones } = await getSettings();
  if (command === 'transpose-up') await setSemitones(semitones + 1);
  else if (command === 'transpose-down') await setSemitones(semitones - 1);
  else if (command === 'transpose-reset') await setSemitones(0);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.semitones) updateBadge(changes.semitones.newValue ?? 0);
});

async function init() {
  const { semitones } = await getSettings();
  await updateBadge(semitones);
}

chrome.runtime.onInstalled.addListener(async () => {
  await init();
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  await Promise.all(tabs.map((t) => injectContentScript(t.id).catch(() => {})));
});
chrome.runtime.onStartup.addListener(init);

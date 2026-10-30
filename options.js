import { getSettings, saveSettings } from './lib/settings.js';

const form = document.querySelector('main');
const field = (name) => form.querySelector(`[name="${name}"]`);

function showQuality() {
  document.getElementById('qualityValue').textContent = `${Math.round(field('jpgQuality').value * 100)}%`;
}

async function load() {
  const s = await getSettings();
  field('openEditor').checked = s.openEditor;
  field('jpgQuality').value = s.jpgQuality;
  form.querySelector(`[name="pdfMode"][value="${s.pdfMode}"]`).checked = true;
  field('extraDelay').value = s.extraDelay;
  showQuality();
}

field('jpgQuality').addEventListener('input', showQuality);

document.getElementById('save').addEventListener('click', async () => {
  await saveSettings({
    openEditor: field('openEditor').checked,
    jpgQuality: Number(field('jpgQuality').value),
    pdfMode: form.querySelector('[name="pdfMode"]:checked').value,
    extraDelay: Math.max(0, Math.min(5000, Number(field('extraDelay').value) || 0)),
  });
  const saved = document.getElementById('saved');
  saved.textContent = 'Salvo.';
  setTimeout(() => (saved.textContent = ''), 2000);
});

// Links chrome:// não abrem por <a href>; precisa da API de abas.
document.getElementById('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

load();

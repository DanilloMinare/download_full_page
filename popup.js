import { newId, putCapture } from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { makeThumb } from './lib/image.js';

const MIN_CAPTURE_INTERVAL = 550;      // o Chrome aceita no máximo 2 captureVisibleTab por segundo
const MAX_PART_HEIGHT = 32000;         // altura segura de um canvas
const MAX_CANVAS_WIDTH = 32000;
const MAX_PART_AREA = 200_000_000;     // área segura de um canvas (o limite do Chrome é ~268M px)
const MAX_TOTAL_PIXELS = 600_000_000;  // acima disso a memória da aba estoura

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let running = false;
let cancelled = false;
let lastCaptureAt = 0;

function setStatus(text, progress) {
  $('status').textContent = text;
  if (progress != null) $('bar').style.width = `${Math.round(progress * 100)}%`;
}

function showError(message) {
  running = false;
  $('status').textContent = message;
  $('status').classList.add('error');
  $('progress').hidden = true;
  $('hint').hidden = true;
  $('cancel').textContent = 'Fechar';
  $('retry').hidden = false;
}

$('cancel').addEventListener('click', () => {
  if (running) {
    cancelled = true;
    setStatus('Cancelando…');
  } else {
    window.close();
  }
});
$('retry').addEventListener('click', () => location.reload());

async function blockedReason(url) {
  if (!url) return 'Não foi possível acessar esta aba.';
  if (/^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|about|view-source):/.test(url)) {
    return 'O Chrome não permite capturar páginas internas do navegador.';
  }
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)) {
    return 'O Chrome não permite que extensões capturem a Chrome Web Store.';
  }
  if (url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return 'Para capturar arquivos locais, ative "Permitir acesso aos URLs de arquivo" nos detalhes da extensão em chrome://extensions.';
  }
  return null;
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/activeTab|all_urls|Cannot access/i.test(msg)) {
    return 'Sem permissão para capturar esta aba. Clique no ícone da extensão de novo, com a aba aberta.';
  }
  return `Erro na captura: ${msg}`;
}

// Executa um método de page/capture-page.js na aba. Erros dentro da página voltam como valor,
// porque executeScript não propaga exceções do script injetado de forma confiável.
async function callPage(tabId, method, ...args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (m, a) => {
      try {
        return { ok: true, value: await window.__fullPageCapture[m](...a) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
    args: [method, args],
  });
  if (!res?.result?.ok) throw new Error(res?.result?.error || 'a página não respondeu');
  return res.result.value;
}

async function captureFrame(windowId) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const blob = await (await fetch(dataUrl)).blob();
      return await createImageBitmap(blob);
    } catch (e) {
      if (attempt < 5 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(e.message)) {
        await sleep(600);
        continue;
      }
      throw e;
    }
  }
}

// Costura os quadros em um ou mais canvases (páginas muito altas viram várias partes).
class Stitcher {
  constructor(width, height) {
    const partHeight = Math.max(1, Math.min(MAX_PART_HEIGHT, Math.floor(MAX_PART_AREA / width)));
    this.parts = [];
    for (let top = 0; top < height; top += partHeight) {
      const canvas = new OffscreenCanvas(width, Math.min(partHeight, height - top));
      this.parts.push({ top, canvas, ctx: canvas.getContext('2d') });
    }
  }

  draw(bitmap, sx, sy, sw, sh, dx, dy) {
    for (const p of this.parts) {
      if (dy + sh <= p.top || dy >= p.top + p.canvas.height) continue;
      p.ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy - p.top, sw, sh);
    }
  }
}

async function captureFullPage(tab, settings) {
  const plan = await callPage(tab.id, 'prepare');
  let truncated = false;
  let stitcher = null;
  let scale = 1;

  try {
    // Estimativa pelo devicePixelRatio; a escala real sai do primeiro quadro.
    const limit = Math.floor(MAX_TOTAL_PIXELS / (plan.width * plan.dpr * plan.dpr));
    if (plan.height > limit) {
      truncated = true;
      plan.height = limit;
      plan.positions = plan.positions.filter((p) => p.y + plan.offset.y < limit);
    }

    const total = plan.positions.length;
    for (const [i, pos] of plan.positions.entries()) {
      if (cancelled) return null;
      setStatus(total > 1 ? `Capturando ${i + 1} de ${total}…` : 'Capturando…', i / total);

      const actual = await callPage(tab.id, 'scrollTo', pos.x, pos.y, i, settings.extraDelay);
      const bitmap = await captureFrame(tab.windowId);
      if (!stitcher) {
        scale = bitmap.width / plan.viewport.w;
        stitcher = new Stitcher(
          Math.min(Math.round(plan.width * scale), MAX_CANVAS_WIDTH),
          Math.round(plan.height * scale),
        );
      }
      const sx = Math.round(plan.crop.left * scale);
      const sy = Math.round(plan.crop.top * scale);
      const sw = Math.min(Math.round(plan.crop.width * scale), bitmap.width - sx);
      const sh = Math.min(Math.round(plan.crop.height * scale), bitmap.height - sy);
      const dx = Math.round((actual.x + plan.offset.x) * scale);
      const dy = Math.round((actual.y + plan.offset.y) * scale);
      stitcher.draw(bitmap, sx, sy, sw, sh, dx, dy);
      bitmap.close();
    }
  } finally {
    await callPage(tab.id, 'restore').catch(() => {});
  }
  return { canvases: stitcher.parts.map((p) => p.canvas), scale, truncated };
}

// Páginas onde não dá para injetar script (ex.: visualizador de PDF do Chrome).
async function captureVisibleOnly(tab) {
  setStatus('Esta página não permite rolagem automática; capturando só a parte visível…', 0.5);
  const bitmap = await captureFrame(tab.windowId);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvases: [canvas], scale: window.devicePixelRatio, visibleOnly: true };
}

async function run() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const reason = await blockedReason(tab?.url);
  if (reason) return showError(reason);

  running = true;
  const settings = await getSettings();
  setStatus('Preparando a página…', 0);

  let injected = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page/capture-page.js'] });
  } catch {
    injected = false;
  }

  const result = injected ? await captureFullPage(tab, settings) : await captureVisibleOnly(tab);
  if (!result) {
    window.close();
    return;
  }

  const { canvases } = result;
  const parts = [];
  for (const [i, canvas] of canvases.entries()) {
    setStatus(canvases.length > 1 ? `Gerando imagem ${i + 1} de ${canvases.length}…` : 'Gerando imagem…', 1);
    parts.push({ blob: await canvas.convertToBlob({ type: 'image/png' }), width: canvas.width, height: canvas.height });
  }

  setStatus('Salvando…', 1);
  const id = newId();
  await putCapture({
    id,
    title: tab.title || tab.url,
    url: tab.url,
    createdAt: Date.now(),
    scale: result.scale,
    truncated: !!result.truncated,
    visibleOnly: !!result.visibleOnly,
    parts,
    thumb: await makeThumb(canvases[0]),
  });

  running = false;
  const page = settings.openEditor ? 'editor.html' : 'capture.html';
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`${page}?id=${id}`),
    windowId: tab.windowId,
    index: tab.index + 1,
    openerTabId: tab.id,
  });
  window.close();
}

run().catch((e) => showError(friendlyError(e)));

import { getCapture, listCaptures, deleteCapture, onCapturesChanged } from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { baseFilename, blobToJpeg, downloadBlob, formatDate, formatSize } from './lib/image.js';
import { buildPdf } from './lib/pdf.js';

const $ = (id) => document.getElementById(id);

let current = null;       // captura exibida
let objectUrls = [];      // URLs das imagens exibidas, liberadas ao trocar de captura
let listUrls = [];

function toast(text, ms = 2500) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

function selectedId() {
  return new URLSearchParams(location.search).get('id');
}

function partName(base, index) {
  return current.parts.length > 1 ? `${base}_parte-${index + 1}` : base;
}

async function busy(button, label, fn) {
  const buttons = [...document.querySelectorAll('#actions button')];
  const original = button.textContent;
  buttons.forEach((b) => (b.disabled = true));
  button.textContent = label;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(`Erro: ${e.message || e}`, 5000);
  } finally {
    button.textContent = original;
    buttons.forEach((b) => (b.disabled = false));
  }
}

function renderCapture(capture) {
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
  current = capture;

  $('viewer').hidden = !capture;
  $('actions').hidden = !capture;
  $('empty').hidden = !!capture;
  if (!capture) return;

  document.title = `${capture.title} — Captura`;
  $('title').textContent = capture.title;
  $('url').textContent = capture.url;
  $('url').href = capture.url;

  const width = capture.parts[0].width;
  const height = capture.parts.reduce((sum, p) => sum + p.height, 0);
  const partsInfo = capture.parts.length > 1 ? ` · ${capture.parts.length} partes` : '';
  $('meta').textContent = `${formatSize(width, height)}${partsInfo} · ${formatDate(capture.createdAt)}`;

  const notices = [];
  if (capture.visibleOnly) notices.push('Esta página não permite rolagem automática; só a parte visível foi capturada.');
  if (capture.truncated) notices.push('A página era longa demais; foi capturado só o começo dela.');
  if (capture.parts.length > 1) notices.push('A página é muito alta para uma única imagem, por isso foi dividida em partes.');
  $('notice').hidden = notices.length === 0;
  $('notice').textContent = notices.join(' ');
  $('copy').hidden = capture.parts.length > 1;

  const container = $('images');
  container.replaceChildren();
  capture.parts.forEach((part, i) => {
    const url = URL.createObjectURL(part.blob);
    objectUrls.push(url);

    const figure = document.createElement('figure');
    figure.className = 'part';
    figure.style.margin = '0';
    if (capture.parts.length > 1) {
      const header = document.createElement('header');
      const label = document.createElement('span');
      label.textContent = `Parte ${i + 1} de ${capture.parts.length} · ${formatSize(part.width, part.height)}`;
      const edit = document.createElement('button');
      edit.textContent = 'Editar esta parte';
      edit.addEventListener('click', () => openEditor(i));
      header.append(label, edit);
      figure.append(header);
    }
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Captura de ${capture.title}`;
    img.width = Math.round(part.width / (capture.scale || 1));
    img.height = Math.round(part.height / (capture.scale || 1));
    figure.append(img);
    container.append(figure);
  });
}

async function renderList() {
  listUrls.forEach(URL.revokeObjectURL);
  listUrls = [];
  const items = await listCaptures();
  const list = $('list');
  list.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'd';
    li.textContent = 'Nenhuma captura salva.';
    list.append(li);
  }
  for (const item of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `capture.html?id=${encodeURIComponent(item.id)}`;
    if (current?.id === item.id) a.classList.add('active');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      history.pushState(null, '', a.href);
      load();
    });

    const img = document.createElement('img');
    img.alt = '';
    if (item.thumb) {
      const url = URL.createObjectURL(item.thumb);
      listUrls.push(url);
      img.src = url;
    }
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = item.title;
    t.title = item.title;
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = formatDate(item.createdAt);
    a.append(img, t, d);
    li.append(a);
    list.append(li);
  }
  return items;
}

async function load() {
  let id = selectedId();
  let capture = id ? await getCapture(id) : null;
  if (!capture) {
    // Sem id (ou id apagado): mostra a mais recente.
    const [latest] = await listCaptures();
    capture = latest ? await getCapture(latest.id) : null;
    if (capture) history.replaceState(null, '', `capture.html?id=${encodeURIComponent(capture.id)}`);
  }
  renderCapture(capture ?? null);
  await renderList();
}

function openEditor(part = 0) {
  location.href = `editor.html?id=${encodeURIComponent(current.id)}&part=${part}`;
}

$('dl-png').addEventListener('click', (e) =>
  busy(e.currentTarget, 'Baixando…', async () => {
    const base = baseFilename(current);
    for (const [i, part] of current.parts.entries()) {
      await downloadBlob(part.blob, `${partName(base, i)}.png`);
    }
  }),
);

$('dl-jpg').addEventListener('click', (e) =>
  busy(e.currentTarget, 'Convertendo…', async () => {
    const { jpgQuality } = await getSettings();
    const base = baseFilename(current);
    for (const [i, part] of current.parts.entries()) {
      await downloadBlob(await blobToJpeg(part.blob, jpgQuality), `${partName(base, i)}.jpg`);
    }
  }),
);

$('dl-pdf').addEventListener('click', (e) =>
  busy(e.currentTarget, 'Gerando PDF…', async () => {
    const { pdfMode, jpgQuality } = await getSettings();
    const pdf = await buildPdf(current.parts, { mode: pdfMode, scale: current.scale || 1, quality: jpgQuality });
    await downloadBlob(pdf, `${baseFilename(current)}.pdf`);
  }),
);

$('copy').addEventListener('click', (e) =>
  busy(e.currentTarget, 'Copiando…', async () => {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': current.parts[0].blob })]);
    toast('Imagem copiada para a área de transferência.');
  }),
);

$('edit').addEventListener('click', () => openEditor(0));

$('delete').addEventListener('click', async () => {
  if (!confirm('Excluir esta captura? Isso não pode ser desfeito.')) return;
  await deleteCapture(current.id);
  history.replaceState(null, '', 'capture.html');
  await load();
  toast('Captura excluída.');
});

window.addEventListener('popstate', load);

onCapturesChanged(async ({ type, id }) => {
  if (type === 'saved' && id === current?.id) {
    renderCapture(await getCapture(id));
  }
  await renderList();
});

load();

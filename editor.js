import { getCapture, putCapture } from './lib/db.js';
import { baseFilename, downloadBlob, makeThumb } from './lib/image.js';

const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const spacer = $('spacer');
const view = $('view');
const ctx = view.getContext('2d');
const textInput = $('textInput');

const MARGIN = 24;            // espaço em volta da imagem (px de tela)
const PIXEL_BLOCK = 14;       // tamanho do bloco do pixelar (px da imagem)
const HISTORY_LIMIT = 100;
const SWATCHES = ['#e11d48', '#f97316', '#facc15', '#16a34a', '#2563eb', '#111827', '#ffffff'];
const WIDTHS = [2, 3, 5, 8];          // em px CSS; multiplicados pela escala da captura
const FONT_SIZES = [14, 18, 24, 32, 48];
const RECT_TYPES = new Set(['rect', 'ellipse', 'highlight', 'pixelate']);
const LINE_TYPES = new Set(['line', 'arrow']);

const params = new URLSearchParams(location.search);
const captureId = params.get('id');
const partIndex = Number(params.get('part') || 0);

const state = {
  capture: null,
  base: null,          // ImageBitmap/OffscreenCanvas da imagem (já com recortes aplicados)
  objects: [],         // anotações, em coordenadas da imagem
  selected: null,
  tool: 'arrow',
  zoom: 1,
  draft: null,         // objeto sendo desenhado
  drag: null,          // { start, original } ao mover um objeto
  crop: null,          // { x, y, w, h } durante o recorte
  cropping: false,
  editingText: null,   // { obj | null, x, y }
  dirty: false,
  dpr: window.devicePixelRatio || 1,
  colors: { default: SWATCHES[0], highlight: '#facc15' },
};
const history = { stack: [], index: -1 };

// ---------- utilidades ----------

function toast(text, ms = 2500) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

function scaleUnit() {
  return state.capture?.scale || 1;
}

function normalizeRect(o) {
  if (o.w < 0) { o.x += o.w; o.w = -o.w; }
  if (o.h < 0) { o.y += o.h; o.h = -o.h; }
  return o;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function textFont(size) {
  return `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
}

const measureCtx = new OffscreenCanvas(1, 1).getContext('2d');

function textBox(o) {
  measureCtx.font = textFont(o.size);
  const lines = o.text.split('\n');
  const w = Math.max(...lines.map((l) => measureCtx.measureText(l).width), o.size / 2);
  return { x: o.x, y: o.y, w, h: lines.length * o.size * 1.25 };
}

function bbox(o) {
  if (RECT_TYPES.has(o.type)) return normalizeRect({ x: o.x, y: o.y, w: o.w, h: o.h });
  if (o.type === 'text') return textBox(o);
  const pts = o.type === 'pen' ? o.points : [[o.x1, o.y1], [o.x2, o.y2]];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = o.width / 2;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len)) : 0;
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

function hitTest(o, p) {
  const tol = Math.max(6 / state.zoom, (o.width || 0) / 2 + 2);
  if (LINE_TYPES.has(o.type)) return distToSegment(p, [o.x1, o.y1], [o.x2, o.y2]) <= tol;
  if (o.type === 'pen') {
    if (o.points.length === 1) return Math.hypot(p.x - o.points[0][0], p.y - o.points[0][1]) <= tol;
    return o.points.some((pt, i) => i > 0 && distToSegment(p, o.points[i - 1], pt) <= tol);
  }
  const b = bbox(o);
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}

function findObjectAt(p) {
  for (let i = state.objects.length - 1; i >= 0; i--) {
    if (hitTest(state.objects[i], p)) return state.objects[i];
  }
  return null;
}

function translate(o, dx, dy) {
  if (LINE_TYPES.has(o.type)) {
    o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
  } else if (o.type === 'pen') {
    o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  } else {
    o.x += dx; o.y += dy;
  }
}

// ---------- desenho ----------

function pixelate(c, o, toDevice) {
  // Limitado à imagem e ao canvas, para não ler o fundo em volta da imagem.
  const a = toDevice(Math.max(0, o.x), Math.max(0, o.y));
  const b = toDevice(Math.min(state.base.width, o.x + o.w), Math.min(state.base.height, o.y + o.h));
  const x0 = Math.floor(Math.max(0, a.x));
  const y0 = Math.floor(Math.max(0, a.y));
  const x1 = Math.ceil(Math.min(c.canvas.width, b.x));
  const y1 = Math.ceil(Math.min(c.canvas.height, b.y));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const block = Math.max(2, o.block * toDevice.scale);
  const tw = Math.max(1, Math.round(w / block));
  const th = Math.max(1, Math.round(h / block));
  const tmp = new OffscreenCanvas(tw, th);
  tmp.getContext('2d').drawImage(c.canvas, x0, y0, w, h, 0, 0, tw, th);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.imageSmoothingEnabled = false;
  c.drawImage(tmp, 0, 0, tw, th, x0, y0, w, h);
  c.restore();
}

function drawArrow(c, o) {
  const angle = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
  const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  const head = Math.min(len, Math.max(12, o.width * 4));
  const spread = Math.PI / 7;
  const bx = o.x2 - Math.cos(angle) * head * 0.8;
  const by = o.y2 - Math.sin(angle) * head * 0.8;
  c.beginPath();
  c.moveTo(o.x1, o.y1);
  c.lineTo(bx, by);
  c.stroke();
  c.beginPath();
  c.moveTo(o.x2, o.y2);
  c.lineTo(o.x2 - Math.cos(angle - spread) * head, o.y2 - Math.sin(angle - spread) * head);
  c.lineTo(o.x2 - Math.cos(angle + spread) * head, o.y2 - Math.sin(angle + spread) * head);
  c.closePath();
  c.fill();
}

function drawObject(c, o, toDevice) {
  c.save();
  c.strokeStyle = o.color;
  c.fillStyle = o.color;
  c.lineWidth = o.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  switch (o.type) {
    case 'rect':
      c.strokeRect(o.x, o.y, o.w, o.h);
      break;
    case 'ellipse':
      c.beginPath();
      c.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, Math.PI * 2);
      c.stroke();
      break;
    case 'highlight':
      c.globalCompositeOperation = 'multiply';
      c.globalAlpha = 0.55;
      c.fillRect(o.x, o.y, o.w, o.h);
      break;
    case 'line':
      c.beginPath();
      c.moveTo(o.x1, o.y1);
      c.lineTo(o.x2, o.y2);
      c.stroke();
      break;
    case 'arrow':
      drawArrow(c, o);
      break;
    case 'pen':
      c.beginPath();
      c.moveTo(...o.points[0]);
      if (o.points.length === 1) c.lineTo(o.points[0][0] + 0.01, o.points[0][1]);
      for (const p of o.points.slice(1)) c.lineTo(...p);
      c.stroke();
      break;
    case 'text': {
      c.font = textFont(o.size);
      c.textBaseline = 'top';
      c.lineWidth = Math.max(2, o.size / 6);
      c.strokeStyle = luminance(o.color) > 0.6 ? '#000' : '#fff';
      o.text.split('\n').forEach((line, i) => {
        const y = o.y + i * o.size * 1.25 + o.size * 0.1;
        c.strokeText(line, o.x, y);
        c.fillText(line, o.x, y);
      });
      break;
    }
    case 'pixelate':
      pixelate(c, o, toDevice);
      break;
  }
  c.restore();
}

// Origem da imagem na tela (px CSS, relativo ao canto do scroller).
function origin() {
  const contentW = state.base.width * state.zoom + MARGIN * 2;
  const contentH = state.base.height * state.zoom + MARGIN * 2;
  return {
    x: MARGIN + Math.max(0, (scroller.clientWidth - contentW) / 2) - scroller.scrollLeft,
    y: MARGIN + Math.max(0, (scroller.clientHeight - contentH) / 2) - scroller.scrollTop,
  };
}

function toImage(e) {
  const r = scroller.getBoundingClientRect();
  const o = origin();
  return { x: (e.clientX - r.left - o.x) / state.zoom, y: (e.clientY - r.top - o.y) / state.zoom };
}

let frameRequested = false;
function requestRender() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    render();
  });
}

function render() {
  if (!state.base) return;
  const { dpr, zoom, base } = state;
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  if (view.width !== Math.round(w * dpr) || view.height !== Math.round(h * dpr)) {
    view.width = Math.round(w * dpr);
    view.height = Math.round(h * dpr);
    view.style.width = `${w}px`;
    view.style.height = `${h}px`;
  }
  const o = origin();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * o.x, dpr * o.y);

  // Só a parte visível da imagem.
  const ix0 = Math.max(0, Math.floor(-o.x / zoom));
  const iy0 = Math.max(0, Math.floor(-o.y / zoom));
  const ix1 = Math.min(base.width, Math.ceil((w - o.x) / zoom));
  const iy1 = Math.min(base.height, Math.ceil((h - o.y) / zoom));
  ctx.save();
  ctx.shadowColor = 'rgb(0 0 0 / 0.25)';
  ctx.shadowBlur = 8 * dpr;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, base.width, base.height);
  ctx.restore();
  if (ix1 > ix0 && iy1 > iy0) {
    ctx.drawImage(base, ix0, iy0, ix1 - ix0, iy1 - iy0, ix0, iy0, ix1 - ix0, iy1 - iy0);
  }

  const toDevice = Object.assign(
    (x, y) => ({ x: dpr * (o.x + x * zoom), y: dpr * (o.y + y * zoom) }),
    { scale: dpr * zoom },
  );
  const objects = state.draft ? [...state.objects, state.draft] : state.objects;
  for (const obj of objects) {
    if (obj === state.editingText?.obj) continue;
    drawObject(ctx, obj, toDevice);
  }

  if (state.selected && !state.editingText) {
    const b = bbox(state.selected);
    const pad = 4 / zoom;
    ctx.save();
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.strokeStyle = '#2563eb';
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.restore();
  }

  if (state.cropping && state.crop) {
    const c = normalizeRect({ ...state.crop });
    ctx.save();
    ctx.fillStyle = 'rgb(0 0 0 / 0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, base.width, base.height);
    ctx.rect(c.x, c.y, c.w, c.h);
    ctx.fill('evenodd');
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.restore();
  }

  positionTextInput();
}

// Imagem final em tamanho real: base + anotações.
function flatten() {
  const canvas = new OffscreenCanvas(state.base.width, state.base.height);
  const c = canvas.getContext('2d');
  c.drawImage(state.base, 0, 0);
  const identity = Object.assign((x, y) => ({ x, y }), { scale: 1 });
  for (const o of state.objects) drawObject(c, o, identity);
  return canvas;
}

// ---------- layout e zoom ----------

function updateSpacer() {
  spacer.style.width = `${state.base.width * state.zoom + MARGIN * 2}px`;
  spacer.style.height = `${state.base.height * state.zoom + MARGIN * 2}px`;
  $('zoomLabel').textContent = `${Math.round(state.zoom * scaleUnit() * 100)}%`;
}

function setZoom(zoom, anchor) {
  zoom = Math.max(0.05, Math.min(8, zoom));
  const r = scroller.getBoundingClientRect();
  const local = anchor
    ? { x: anchor.clientX - r.left, y: anchor.clientY - r.top }
    : { x: scroller.clientWidth / 2, y: scroller.clientHeight / 2 };
  const before = toImage({ clientX: r.left + local.x, clientY: r.top + local.y });

  state.zoom = zoom;
  updateSpacer();
  const contentW = state.base.width * zoom + MARGIN * 2;
  const contentH = state.base.height * zoom + MARGIN * 2;
  const baseX = MARGIN + Math.max(0, (scroller.clientWidth - contentW) / 2);
  const baseY = MARGIN + Math.max(0, (scroller.clientHeight - contentH) / 2);
  scroller.scrollLeft = baseX + before.x * zoom - local.x;
  scroller.scrollTop = baseY + before.y * zoom - local.y;
  render();
}

function zoomToFit() {
  const fit = (scroller.clientWidth - MARGIN * 2) / state.base.width;
  // "100%" = tamanho em que a página foi vista no navegador.
  const natural = 1 / scaleUnit();
  state.zoom = Math.max(0.05, Math.min(fit, natural));
  updateSpacer();
  scroller.scrollLeft = 0;
  scroller.scrollTop = 0;
  render();
}

// ---------- histórico ----------

function snapshot() {
  return { base: state.base, objects: structuredClone(state.objects) };
}

function commit() {
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(snapshot());
  if (history.stack.length > HISTORY_LIMIT) history.stack.shift();
  history.index = history.stack.length - 1;
  state.dirty = true;
  updateButtons();
}

function restoreSnapshot(s) {
  const baseChanged = s.base !== state.base;
  state.base = s.base;
  state.objects = structuredClone(s.objects);
  state.selected = null;
  state.dirty = true;
  if (baseChanged) zoomToFit();
  updateButtons();
  render();
}

function undo() {
  if (history.index <= 0) return;
  history.index--;
  restoreSnapshot(history.stack[history.index]);
}

function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  restoreSnapshot(history.stack[history.index]);
}

function updateButtons() {
  $('undo').disabled = history.index <= 0;
  $('redo').disabled = history.index >= history.stack.length - 1;
  $('remove').disabled = !state.selected;
}

// ---------- ferramentas e propriedades ----------

function currentColor() {
  return $('color').value;
}

function setColor(color, apply = true) {
  $('color').value = color;
  state.colors[state.tool === 'highlight' ? 'highlight' : 'default'] = color;
  document.querySelectorAll('#swatches button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.color === color));
  });
  if (apply) applyToSelected({ color });
}

function applyToSelected(props) {
  const o = state.selected;
  if (!o) return;
  if (props.width != null && !('width' in o)) delete props.width;
  if (props.size != null && o.type !== 'text') delete props.size;
  if (props.color && o.type === 'pixelate') delete props.color;
  if (Object.keys(props).length === 0) return;
  Object.assign(o, props);
  commit();
  render();
}

function setTool(tool) {
  if (state.cropping && tool !== 'crop') cancelCrop();
  finishTextEdit();
  state.tool = tool;
  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  });
  if (tool !== 'select') state.selected = null;
  setColor(tool === 'highlight' ? state.colors.highlight : state.colors.default, false);

  scroller.style.cursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
  if (tool === 'crop') {
    state.cropping = true;
    state.crop = null;
    $('cropBar').hidden = false;
    $('cropApply').disabled = true;
  }
  updateButtons();
  render();
}

function cancelCrop() {
  state.cropping = false;
  state.crop = null;
  $('cropBar').hidden = true;
  render();
}

function applyCrop() {
  if (!state.crop) return;
  const c = normalizeRect({ ...state.crop });
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  const w = Math.round(c.w);
  const h = Math.round(c.h);
  if (w < 2 || h < 2) return;
  const flat = flatten();
  const cropped = new OffscreenCanvas(w, h);
  cropped.getContext('2d').drawImage(flat, x, y, w, h, 0, 0, w, h);
  state.base = cropped;
  state.objects = [];
  state.selected = null;
  commit();
  cancelCrop();
  setTool('select');
  zoomToFit();
}

// ---------- texto ----------

function openTextEdit(p, obj = null) {
  finishTextEdit();
  const size = obj ? obj.size : Number($('fontSize').value);
  const color = obj ? obj.color : currentColor();
  state.editingText = { obj, x: obj ? obj.x : p.x, y: obj ? obj.y : p.y, size, color };
  textInput.value = obj ? obj.text : '';
  textInput.style.color = color;
  textInput.hidden = false;
  render();
  autoSizeText();
  // Adiado: o mousedown que abriu a caixa ainda vai mudar o foco depois deste handler.
  setTimeout(() => textInput.focus(), 0);
}

function positionTextInput() {
  if (!state.editingText) return;
  const o = origin();
  const size = state.editingText.size * state.zoom;
  textInput.style.left = `${o.x + state.editingText.x * state.zoom - 1}px`;
  textInput.style.top = `${o.y + state.editingText.y * state.zoom - 1}px`;
  textInput.style.fontSize = `${size}px`;
}

function autoSizeText() {
  textInput.style.width = '0';
  textInput.style.height = '0';
  textInput.style.width = `${Math.max(40, textInput.scrollWidth + 8)}px`;
  textInput.style.height = `${textInput.scrollHeight}px`;
}

function finishTextEdit(cancel = false) {
  const edit = state.editingText;
  if (!edit) return;
  state.editingText = null;
  textInput.hidden = true;
  const text = textInput.value.replace(/\s+$/, '');
  if (!cancel) {
    if (edit.obj) {
      if (!text) {
        state.objects = state.objects.filter((o) => o !== edit.obj);
        state.selected = null;
      } else {
        edit.obj.text = text;
      }
      commit();
    } else if (text) {
      const obj = { type: 'text', x: edit.x, y: edit.y, text, color: edit.color, size: edit.size };
      state.objects.push(obj);
      state.selected = obj;
      commit();
    }
  }
  updateButtons();
  render();
}

textInput.addEventListener('input', autoSizeText);
textInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') finishTextEdit(true);
  else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    finishTextEdit();
  }
});
textInput.addEventListener('blur', () => finishTextEdit());

// ---------- ponteiro ----------

function snapLine(o, shift) {
  if (!shift) return;
  const angle = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  o.x2 = o.x1 + Math.cos(snapped) * len;
  o.y2 = o.y1 + Math.sin(snapped) * len;
}

function clampToImage(p) {
  return {
    x: Math.max(0, Math.min(state.base.width, p.x)),
    y: Math.max(0, Math.min(state.base.height, p.y)),
  };
}

scroller.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.base) return;
  if (e.offsetX >= scroller.clientWidth || e.offsetY >= scroller.clientHeight) return; // barra de rolagem
  if (state.editingText) {
    finishTextEdit();
    return;
  }
  const p = toImage(e);
  const unit = scaleUnit();
  const width = Number($('width').value);
  const color = currentColor();
  scroller.setPointerCapture(e.pointerId);

  switch (state.tool) {
    case 'select': {
      state.selected = findObjectAt(p);
      if (state.selected) state.drag = { start: p, original: structuredClone(state.selected), moved: false };
      break;
    }
    case 'crop': {
      const c = clampToImage(p);
      state.crop = { x: c.x, y: c.y, w: 0, h: 0 };
      break;
    }
    case 'text': {
      const hit = findObjectAt(p);
      if (hit?.type === 'text') openTextEdit(p, hit);
      else openTextEdit(p);
      scroller.releasePointerCapture(e.pointerId);
      return;
    }
    case 'pen':
      state.draft = { type: 'pen', points: [[p.x, p.y]], color, width };
      break;
    case 'line':
    case 'arrow':
      state.draft = { type: state.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width };
      break;
    case 'pixelate':
      state.draft = { type: 'pixelate', x: p.x, y: p.y, w: 0, h: 0, block: PIXEL_BLOCK * unit / 2 };
      break;
    default:
      state.draft = { type: state.tool, x: p.x, y: p.y, w: 0, h: 0, color, width };
  }
  updateButtons();
  render();
});

scroller.addEventListener('pointermove', (e) => {
  if (!state.base) return;
  const p = toImage(e);

  if (state.drag) {
    const o = state.selected;
    const orig = state.drag.original;
    Object.assign(o, structuredClone(orig));
    translate(o, p.x - state.drag.start.x, p.y - state.drag.start.y);
    state.drag.moved = true;
    requestRender();
    return;
  }
  if (state.cropping && state.crop && e.buttons & 1) {
    const c = clampToImage(p);
    state.crop.w = c.x - state.crop.x;
    state.crop.h = c.y - state.crop.y;
    requestRender();
    return;
  }
  const d = state.draft;
  if (!d) {
    if (state.tool === 'select') scroller.style.cursor = findObjectAt(p) ? 'move' : 'default';
    return;
  }
  if (d.type === 'pen') {
    const last = d.points[d.points.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) * state.zoom >= 2) d.points.push([p.x, p.y]);
  } else if (LINE_TYPES.has(d.type)) {
    d.x2 = p.x;
    d.y2 = p.y;
    snapLine(d, e.shiftKey);
  } else {
    d.w = p.x - d.x;
    d.h = p.y - d.y;
    if (e.shiftKey) {
      const s = Math.max(Math.abs(d.w), Math.abs(d.h));
      d.w = Math.sign(d.w || 1) * s;
      d.h = Math.sign(d.h || 1) * s;
    }
  }
  requestRender();
});

function endPointer() {
  if (state.drag) {
    if (state.drag.moved) commit();
    state.drag = null;
  }
  if (state.cropping && state.crop) {
    const c = normalizeRect({ ...state.crop });
    $('cropApply').disabled = c.w < 2 || c.h < 2;
  }
  const d = state.draft;
  if (d) {
    state.draft = null;
    let keep = true;
    if (RECT_TYPES.has(d.type)) {
      normalizeRect(d);
      keep = d.w * state.zoom >= 3 && d.h * state.zoom >= 3;
    } else if (LINE_TYPES.has(d.type)) {
      keep = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * state.zoom >= 3;
    }
    if (keep) {
      state.objects.push(d);
      state.selected = d;
      commit();
    }
  }
  updateButtons();
  render();
}

scroller.addEventListener('pointerup', endPointer);
scroller.addEventListener('pointercancel', endPointer);

scroller.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select') return;
  const hit = findObjectAt(toImage(e));
  if (hit?.type === 'text') openTextEdit(null, hit);
});

scroller.addEventListener('scroll', requestRender);
scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.base) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.0025), e);
}, { passive: false });

new ResizeObserver(() => {
  if (!state.base) return;
  updateSpacer();
  render();
}).observe(scroller);

// ---------- teclado ----------

const TOOL_KEYS = { v: 'select', c: 'crop', a: 'arrow', l: 'line', r: 'rect', e: 'ellipse', p: 'pen', t: 'text', h: 'highlight', b: 'pixelate' };

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && key === 's') {
    e.preventDefault();
    save();
  } else if (mod && (key === '+' || key === '=')) {
    e.preventDefault();
    setZoom(state.zoom * 1.25);
  } else if (mod && key === '-') {
    e.preventDefault();
    setZoom(state.zoom / 1.25);
  } else if (mod && key === '0') {
    e.preventDefault();
    zoomToFit();
  } else if (key === 'delete' || key === 'backspace') {
    removeSelected();
  } else if (key === 'escape') {
    if (state.cropping) setTool('select');
    state.selected = null;
    updateButtons();
    render();
  } else if (key === 'enter' && state.cropping) {
    applyCrop();
  } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  }
});

function removeSelected() {
  if (!state.selected) return;
  state.objects = state.objects.filter((o) => o !== state.selected);
  state.selected = null;
  commit();
  render();
}

// ---------- salvar / baixar ----------

async function save() {
  finishTextEdit();
  const button = $('save');
  button.disabled = true;
  button.textContent = 'Salvando…';
  try {
    const canvas = flatten();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const capture = await getCapture(captureId);
    capture.parts[partIndex] = { blob, width: canvas.width, height: canvas.height };
    if (partIndex === 0) capture.thumb = await makeThumb(canvas);
    await putCapture(capture);
    state.capture = capture;
    state.dirty = false;
    toast('Captura salva.');
  } catch (e) {
    console.error(e);
    toast(`Erro ao salvar: ${e.message || e}`, 5000);
  } finally {
    button.disabled = false;
    button.textContent = 'Salvar';
  }
}

async function download() {
  finishTextEdit();
  const blob = await flatten().convertToBlob({ type: 'image/png' });
  const suffix = state.capture.parts.length > 1 ? `_parte-${partIndex + 1}` : '';
  await downloadBlob(blob, `${baseFilename(state.capture)}${suffix}_editada.png`);
}

// ---------- inicialização ----------

function fillSelect(select, values, unit, selectedIndex) {
  select.replaceChildren(...values.map((v, i) => {
    const opt = document.createElement('option');
    opt.value = String(Math.round(v * unit));
    opt.textContent = String(v);
    opt.selected = i === selectedIndex;
    return opt;
  }));
}

function setupToolbar() {
  const unit = scaleUnit();
  fillSelect($('width'), WIDTHS, unit, 1);
  fillSelect($('fontSize'), FONT_SIZES, unit, 2);

  $('swatches').replaceChildren(...SWATCHES.map((color) => {
    const b = document.createElement('button');
    b.dataset.color = color;
    b.style.background = color;
    b.title = color;
    b.addEventListener('click', () => setColor(color));
    return b;
  }));

  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  $('color').addEventListener('change', () => setColor($('color').value));
  $('width').addEventListener('change', () => applyToSelected({ width: Number($('width').value) }));
  $('fontSize').addEventListener('change', () => applyToSelected({ size: Number($('fontSize').value) }));
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('remove').addEventListener('click', removeSelected);
  $('zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.25));
  $('zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.25));
  $('zoomFit').addEventListener('click', zoomToFit);
  $('cropApply').addEventListener('click', applyCrop);
  $('cropCancel').addEventListener('click', () => setTool('select'));
  $('save').addEventListener('click', save);
  $('download').addEventListener('click', () => download().catch((e) => toast(`Erro: ${e.message || e}`, 5000)));
  $('back').addEventListener('click', () => {
    if (state.dirty && !confirm('Sair sem salvar as alterações?')) return;
    state.dirty = false;
    location.href = `capture.html?id=${encodeURIComponent(captureId)}`;
  });

  const parts = state.capture.parts;
  if (parts.length > 1) {
    const select = $('part');
    select.hidden = false;
    select.replaceChildren(...parts.map((_, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Parte ${i + 1} de ${parts.length}`;
      opt.selected = i === partIndex;
      return opt;
    }));
    select.addEventListener('change', () => {
      if (state.dirty && !confirm('Trocar de parte sem salvar as alterações?')) {
        select.value = String(partIndex);
        return;
      }
      state.dirty = false;
      location.href = `editor.html?id=${encodeURIComponent(captureId)}&part=${select.value}`;
    });
  }
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

async function init() {
  const capture = captureId ? await getCapture(captureId) : null;
  const part = capture?.parts[partIndex];
  if (!part) {
    $('loading').textContent = 'Captura não encontrada.';
    return;
  }
  state.capture = capture;
  state.base = await createImageBitmap(part.blob);
  document.title = `Editor — ${capture.title}`;
  $('loading').hidden = true;

  setupToolbar();
  history.stack = [snapshot()];
  history.index = 0;
  setTool('arrow');
  zoomToFit();
  updateButtons();
}

init().catch((e) => {
  console.error(e);
  $('loading').textContent = `Erro ao abrir a captura: ${e.message || e}`;
});

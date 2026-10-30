export async function makeThumb(source, width = 320, maxHeight = 400) {
  const scale = Math.min(1, width / source.width);
  const w = Math.round(source.width * scale);
  const h = Math.min(Math.round(source.height * scale), maxHeight);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, source.width, h / scale, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

export async function blobToJpeg(blob, quality = 0.92) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

export function baseFilename(capture) {
  let host = 'pagina';
  try {
    host = new URL(capture.url).hostname.replace(/^www\./, '') || host;
  } catch {}
  const d = new Date(capture.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `captura_${host.replace(/[^a-z0-9.-]/gi, '_')}_${stamp}`;
}

// O object URL precisa viver até o download terminar (o Chrome pode perguntar onde salvar).
export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  let id;
  try {
    id = await chrome.downloads.download({ url, filename });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  const onChanged = (delta) => {
    if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
    chrome.downloads.onChanged.removeListener(onChanged);
    URL.revokeObjectURL(url);
  };
  chrome.downloads.onChanged.addListener(onChanged);
}

export function formatSize(width, height) {
  return `${width.toLocaleString('pt-BR')} × ${height.toLocaleString('pt-BR')} px`;
}

export function formatDate(ms) {
  return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

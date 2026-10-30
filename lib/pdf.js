// Gera PDF com o jsPDF carregado por <script src="lib/jspdf.umd.min.js"> (expõe window.jspdf).

const A4 = { w: 595.28, h: 841.89 };   // pontos
const MAX_PAGE_SIDE = 14400;           // maior página aceita pelo Acrobat (200 polegadas)
const PX_TO_PT = 0.75;                 // 96 dpi → 72 dpi

async function canvasToJpegBytes(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

function sliceToCanvas(bitmap, y, height) {
  const canvas = new OffscreenCanvas(bitmap.width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, y, bitmap.width, height, 0, 0, bitmap.width, height);
  return canvas;
}

// parts: [{ blob, width, height }]; scale: pixels do dispositivo por pixel CSS.
// mode: 'single' (uma página por parte, do tamanho da imagem) ou 'a4' (fatiado em páginas A4).
export async function buildPdf(parts, { mode = 'single', scale = 1, quality = 0.92 } = {}) {
  const { jsPDF } = window.jspdf;
  let doc = null;
  const addPage = (w, h) => {
    const orientation = w > h ? 'landscape' : 'portrait';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true });
    else doc.addPage([w, h], orientation);
  };

  for (const part of parts) {
    const bitmap = await createImageBitmap(part.blob);
    try {
      if (mode === 'a4') {
        const sliceHeight = Math.floor(bitmap.width * (A4.h / A4.w));
        for (let y = 0; y < bitmap.height; y += sliceHeight) {
          const h = Math.min(sliceHeight, bitmap.height - y);
          const bytes = await canvasToJpegBytes(sliceToCanvas(bitmap, y, h), quality);
          addPage(A4.w, A4.h);
          doc.addImage(bytes, 'JPEG', 0, 0, A4.w, h * (A4.w / bitmap.width), undefined, 'NONE');
        }
      } else {
        let w = (bitmap.width / scale) * PX_TO_PT;
        let h = (bitmap.height / scale) * PX_TO_PT;
        const fit = Math.min(1, MAX_PAGE_SIDE / Math.max(w, h));
        w *= fit;
        h *= fit;
        const bytes = await canvasToJpegBytes(sliceToCanvas(bitmap, 0, bitmap.height), quality);
        addPage(w, h);
        doc.addImage(bytes, 'JPEG', 0, 0, w, h, undefined, 'NONE');
      }
    } finally {
      bitmap.close();
    }
  }
  return doc.output('blob');
}

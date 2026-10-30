export const DEFAULT_SETTINGS = {
  jpgQuality: 0.92,     // JPG e imagens dentro do PDF
  pdfMode: 'single',    // 'single' (uma página do tamanho da imagem) | 'a4'
  openEditor: false,    // abrir o editor direto após capturar
  extraDelay: 0,        // ms extras de espera entre quadros
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(values) {
  await chrome.storage.sync.set(values);
}

# Captura de Página Inteira

Extensão do Chrome (Manifest V3) que captura a página inteira, com rolagem.
Escrita do zero em JavaScript puro, sem etapa de build.

## Instalar

1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e escolha esta pasta.
3. Fixe o ícone na barra (ícone de quebra-cabeça → alfinete).

Atalho: **Alt+Shift+P** (dá para mudar em `chrome://extensions/shortcuts`).
Para capturar arquivos locais (`file://`), ative "Permitir acesso aos URLs de arquivo" nos detalhes da extensão.

## Como funciona

- `popup.js` injeta `page/capture-page.js` na aba, rola a página em passos e chama
  `chrome.tabs.captureVisibleTab` a cada passo (no máximo 2 por segundo, limite do Chrome).
  Os quadros são costurados em `OffscreenCanvas`.
- A partir do 2º quadro, elementos `fixed` e `sticky` grudados são escondidos, para não se repetirem.
- Se o documento não rola (apps com layout fixo), é capturado o maior contêiner rolável visível.
- Páginas com mais de 32 000 px de altura viram várias partes.
- As capturas ficam no IndexedDB da extensão (`lib/db.js`) e aparecem em `capture.html`
  (baixar PNG/JPG/PDF, copiar, editar, excluir).
- `editor.html`: recortar, seta, linha, retângulo, elipse, caneta, texto, marca-texto e pixelar,
  com desfazer/refazer. Atalhos: V, C, A, L, R, E, P, T, H, B; Ctrl+Z, Ctrl+Shift+Z, Ctrl+S, Delete.
- O PDF usa o jsPDF 2.5.1 (`lib/jspdf.umd.min.js`), em página única ou fatiado em A4 (ver Opções).

Se o popup for fechado no meio da captura, ela é cancelada e a página volta ao normal sozinha em
alguns segundos.

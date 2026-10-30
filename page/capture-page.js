// Injetado na aba que será capturada. Expõe window.__fullPageCapture no mundo isolado da
// extensão; o popup chama os métodos via chrome.scripting.executeScript, um passo por vez.
(() => {
  if (window.__fullPageCapture) return;

  const STYLE_ID = '__fpc-style';
  const SCROLLER_ATTR = 'data-fpc-scroller';
  // Se o popup fechar no meio da captura ninguém chama restore(); depois desse tempo sem
  // comandos a página volta sozinha ao normal.
  const WATCHDOG_MS = 6000;

  let state = null;
  let watchdog = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(restore, WATCHDOG_MS);
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html, body, * { scroll-behavior: auto !important; }
      html, body, [${SCROLLER_ATTR}] { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar, [${SCROLLER_ATTR}]::-webkit-scrollbar {
        display: none !important; width: 0 !important; height: 0 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function documentScrolls() {
    const el = document.scrollingElement || document.documentElement;
    if (el.scrollHeight <= window.innerHeight + 1 && el.scrollWidth <= window.innerWidth + 1) {
      return false;
    }
    // overflow:hidden no html/body impede a rolagem mesmo com conteúdo maior que a janela.
    const { scrollX: x, scrollY: y } = window;
    window.scrollTo({ left: x, top: y + 1, behavior: 'instant' });
    const moved = window.scrollY !== y;
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
    return moved || y > 0;
  }

  // Quando o documento não rola (apps com layout fixo), usa o maior elemento rolável visível.
  function findScrollContainer() {
    const viewportArea = window.innerWidth * window.innerHeight;
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 1 || el.clientHeight < 80) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = Math.max(0, w) * Math.max(0, h);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return bestArea >= viewportArea * 0.25 ? best : null;
  }

  // Posições de rolagem em passos do tamanho da área capturada; a última encosta no fim.
  function steps(max, step) {
    const positions = [];
    for (let p = 0; ; p += step) {
      if (p >= max) {
        positions.push(max);
        break;
      }
      positions.push(p);
    }
    return positions;
  }

  function prepare() {
    if (state) restore();
    armWatchdog();

    state = {
      docScroll: { x: window.scrollX, y: window.scrollY },
      scroller: null,
      scrollerScroll: null,
      hidden: [],
    };
    injectStyle();

    const viewport = { w: window.innerWidth, h: window.innerHeight };
    let crop = { left: 0, top: 0, width: viewport.w, height: viewport.h };
    let offset = { x: 0, y: 0 };
    let maxX = 0;
    let maxY = 0;

    if (documentScrolls()) {
      const el = document.scrollingElement || document.documentElement;
      maxX = Math.max(0, el.scrollWidth - viewport.w);
      maxY = Math.max(0, el.scrollHeight - viewport.h);
    } else {
      const scroller = findScrollContainer();
      if (scroller) {
        state.scroller = scroller;
        state.scrollerScroll = { x: scroller.scrollLeft, y: scroller.scrollTop };
        scroller.setAttribute(SCROLLER_ATTR, '');
        window.scrollTo({ left: 0, top: 0, behavior: 'instant' });

        const r = scroller.getBoundingClientRect();
        const innerLeft = r.left + scroller.clientLeft;
        const innerTop = r.top + scroller.clientTop;
        const left = Math.max(0, innerLeft);
        const top = Math.max(0, innerTop);
        crop = {
          left,
          top,
          width: Math.min(innerLeft + scroller.clientWidth, viewport.w) - left,
          height: Math.min(innerTop + scroller.clientHeight, viewport.h) - top,
        };
        offset = { x: left - innerLeft, y: top - innerTop };
        maxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        maxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      }
    }

    const xs = steps(maxX, crop.width);
    const ys = steps(maxY, crop.height);
    const positions = [];
    for (const y of ys) for (const x of xs) positions.push({ x, y });

    return {
      viewport,
      dpr: window.devicePixelRatio || 1,
      crop,
      offset,
      positions,
      width: offset.x + maxX + crop.width,
      height: offset.y + maxY + crop.height,
      mode: state.scroller ? 'element' : 'document',
    };
  }

  function currentScroll() {
    const s = state.scroller;
    return s ? { x: s.scrollLeft, y: s.scrollTop } : { x: window.scrollX, y: window.scrollY };
  }

  function hide(el) {
    if (el.hasAttribute('data-fpc-hidden')) return;
    state.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.setAttribute('data-fpc-hidden', '');
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  // Elementos fixos (e sticky "grudados") apareceriam repetidos em todos os quadros; a partir do
  // segundo quadro eles são escondidos.
  function hideFloatingElements() {
    const s = state.scroller;
    const ref = s
      ? (() => {
          const r = s.getBoundingClientRect();
          return { top: r.top + s.clientTop, bottom: r.top + s.clientTop + s.clientHeight };
        })()
      : { top: 0, bottom: window.innerHeight };

    for (const el of document.querySelectorAll('body *')) {
      if (el.hasAttribute('data-fpc-hidden')) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) continue;

      if (cs.position === 'sticky') {
        const stuckTop = cs.top !== 'auto' && Math.abs(r.top - ref.top - parseFloat(cs.top)) < 2;
        const stuckBottom = cs.bottom !== 'auto' && Math.abs(ref.bottom - r.bottom - parseFloat(cs.bottom)) < 2;
        if (!stuckTop && !stuckBottom) continue;
      }
      hide(el);
    }
  }

  async function scrollTo(x, y, index, extraDelay = 0) {
    if (!state) throw new Error('A captura foi interrompida (a página ficou muito tempo sem resposta).');
    armWatchdog();
    if (state.scroller) {
      state.scroller.scrollLeft = x;
      state.scroller.scrollTop = y;
    } else {
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
    }
    await nextFrame();
    if (index > 0) hideFloatingElements();
    await nextFrame();
    await nextFrame();
    await sleep(120 + extraDelay);
    armWatchdog();
    return currentScroll();
  }

  function restore() {
    clearTimeout(watchdog);
    if (!state) return;
    for (const [el, value, priority] of state.hidden) {
      el.removeAttribute('data-fpc-hidden');
      if (value) el.style.setProperty('visibility', value, priority);
      else el.style.removeProperty('visibility');
    }
    document.getElementById(STYLE_ID)?.remove();
    if (state.scroller) {
      state.scroller.removeAttribute(SCROLLER_ATTR);
      state.scroller.scrollLeft = state.scrollerScroll.x;
      state.scroller.scrollTop = state.scrollerScroll.y;
    }
    window.scrollTo({ left: state.docScroll.x, top: state.docScroll.y, behavior: 'instant' });
    state = null;
  }

  window.__fullPageCapture = { prepare, scrollTo, restore };
})();

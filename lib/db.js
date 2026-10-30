// Armazena as capturas no IndexedDB da extensão.
// Registro: { id, title, url, createdAt, parts: [{ blob, width, height }], thumb: Blob }

const DB_NAME = 'capturas';
const STORE = 'captures';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Avisa as outras páginas da extensão (aba de resultado, editor) que algo mudou.
const channel = new BroadcastChannel('capturas');

export function onCapturesChanged(callback) {
  channel.addEventListener('message', (e) => callback(e.data));
}

export async function putCapture(capture) {
  await withStore('readwrite', (store) => store.put(capture));
  channel.postMessage({ type: 'saved', id: capture.id });
}

export function getCapture(id) {
  return withStore('readonly', (store) => store.get(id));
}

export async function deleteCapture(id) {
  await withStore('readwrite', (store) => store.delete(id));
  channel.postMessage({ type: 'deleted', id });
}

// Lista as capturas da mais recente para a mais antiga, sem carregar as imagens grandes.
export async function listCaptures() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const items = [];
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).index('createdAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const { id, title, url, createdAt, parts, thumb } = cursor.value;
        items.push({
          id, title, url, createdAt, thumb,
          width: parts[0]?.width ?? 0,
          height: parts.reduce((sum, p) => sum + p.height, 0),
          partCount: parts.length,
        });
        cursor.continue();
      };
      tx.oncomplete = () => resolve(items);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Conversations live in IndexedDB (localStorage is too small once images and
// PDFs are in the history). One record per conversation:
//   { id, title, createdAt, updatedAt, messages: [{ role, content, display? }] }
// `content` is exactly what goes to the Claude API; `display` is UI-only.
// A small key/value store alongside holds the API key.

const DB_NAME = "jarvis";
const STORE = "conversations";
const KV = "kv";

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      if (!names.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      if (!names.contains(KV)) req.result.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn, storeName = STORE) {
  const store = (await db()).transaction(storeName, mode).objectStore(storeName);
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const listConversations = async () =>
  (await tx("readonly", (s) => s.getAll())).sort((a, b) => b.updatedAt - a.updatedAt);
export const getConversation = (id) => tx("readonly", (s) => s.get(id));
export const saveConversation = (conv) => tx("readwrite", (s) => s.put(conv));
export const deleteConversation = (id) => tx("readwrite", (s) => s.delete(id));

export const getSetting = (key) => tx("readonly", (s) => s.get(key), KV);
export const setSetting = (key, value) => tx("readwrite", (s) => s.put(value, key), KV);
export const deleteSetting = (key) => tx("readwrite", (s) => s.delete(key), KV);

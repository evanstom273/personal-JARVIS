// Conversations live in IndexedDB (localStorage is too small once images and
// PDFs are in the history). One record per conversation:
//   { id, title, createdAt, updatedAt, messages: [{ role, content, display? }] }
// `content` is exactly what goes to the Claude API; `display` is UI-only.

const DB_NAME = "jarvis";
const STORE = "conversations";

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
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

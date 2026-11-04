// Clips recorded in live mode are kept in IndexedDB on this device. localStorage holds text only and is too small for
// a video, so each clip is stored as a Blob. Nothing here is sent anywhere.

const DB_NAME = 'js-rusty-clips';
const DB_VERSION = 1;
const STORE = 'clips';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so clips cannot be kept.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Clip storage could not be opened.'));
    };
  });
  return dbPromise;
}

// Runs one request in a transaction and resolves with its result.
function run(mode, action) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('Clip storage failed.'));
    tx.onabort = () => reject(tx.error || new Error('The browser stopped the clip storage.'));
  }));
}

// Asks the browser to keep this site's storage. Safari may still clear it after a week without use.
function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// Saves a recorded clip. Returns its details (without the Blob).
export async function saveClip({ blob, duration, width, height }) {
  requestPersistence();
  const now = Date.now();
  const id = now.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const ext = blob.type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // The bytes are stored as an ArrayBuffer, not a Blob: Safari has failed to store some Blobs in IndexedDB.
  const data = await blob.arrayBuffer();
  const record = {
    id: id,
    name: 'live-' + stamp + '.' + ext,
    createdAt: now,
    duration: duration,
    width: width || 0,
    height: height || 0,
    type: blob.type,
    size: blob.size,
    data: data,
  };
  await run('readwrite', (store) => store.put(record));
  return metaOf(record);
}

// Every clip, newest first, without the Blobs.
export async function listClips() {
  const all = await run('readonly', (store) => store.getAll());
  return (all || []).map(metaOf).sort((a, b) => b.createdAt - a.createdAt);
}

// One clip with its Blob, or undefined. The Blob is rebuilt from the stored bytes. Clips saved with a Blob by an earlier
// version are read as they are.
export async function getClip(id) {
  const record = await run('readonly', (store) => store.get(id));
  if (!record) return undefined;
  const blob = record.blob || new Blob([record.data], { type: record.type });
  return { id: record.id, name: record.name, type: record.type, size: record.size, blob: blob };
}

export function deleteClip(id) {
  return run('readwrite', (store) => store.delete(id));
}

// Storage used by this site and its quota, when the browser reports them. Otherwise null.
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
  } catch (err) {
    return null;
  }
}

function metaOf(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    duration: record.duration,
    width: record.width,
    height: record.height,
    type: record.type,
    size: record.size,
  };
}

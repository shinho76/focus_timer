/**
 * In-memory Storage-like fake (implements the subset of the Web Storage API
 * that ports/storage.js relies on: getItem/setItem/removeItem).
 * Set throwOnWrite to simulate a full/blocked quota (private browsing, etc.).
 */
export function createMemStorage({ throwOnWrite = false } = {}) {
  const map = new Map();
  return {
    get throwOnWrite() {
      return throwOnWrite;
    },
    set throwOnWrite(v) {
      throwOnWrite = v;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throwOnWrite) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

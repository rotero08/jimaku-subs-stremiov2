// A memory cache with expiry, a size limit that drops the least recently used entries first,
// and in-flight de-duplication: many requests for the same thing share one upstream call.

export class TtlCache {
  /**
   * @param {object} options
   * @param {number} [options.maxEntries]
   * @param {number} [options.maxWeight]       total size allowed, by `weigh`
   * @param {(value: unknown) => number} [options.weigh]
   * @param {() => number} [options.now]       injectable clock, for tests
   */
  constructor({ maxEntries = 1000, maxWeight = Infinity, weigh = () => 1, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
    this.weigh = weigh;
    this.now = now;
    this.entries = new Map(); // key -> { value, expires, weight }; Map order is recency order
    this.pending = new Map();
    this.weight = 0;
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry); // most recently used goes last
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs) {
    this.delete(key);
    const weight = this.weigh(value);
    if (weight > this.maxWeight) return; // never fits
    this.entries.set(key, { value, expires: this.now() + ttlMs, weight });
    this.weight += weight;
    while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
      this.delete(this.entries.keys().next().value);
    }
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.weight -= entry.weight;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.pending.clear();
    this.weight = 0;
  }

  /**
   * The cached value for `key`, or the result of `load()`, cached for `ttl` (a number, or a
   * function of the value for answers that should live shorter or longer). Concurrent calls for
   * the same key wait on one `load()`. A failed load is not cached and does not poison the key.
   */
  async wrap(key, ttl, load) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = (async () => {
      try {
        const value = await load();
        this.set(key, value, typeof ttl === 'function' ? ttl(value) : ttl);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, promise);
    return promise;
  }
}

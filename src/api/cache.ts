/** Small TTL cache that also shares in-flight requests (same key → one request). */
export class TtlCache {
  private entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

  constructor(private now: () => number = Date.now) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (ttlMs <= 0) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { expiresAt: this.now() + ttlMs, value });
    value.catch(() => this.entries.delete(key)); // never cache errors
    if (this.entries.size > 500) this.prune();
    return value;
  }

  clear() {
    this.entries.clear();
  }

  private prune() {
    const now = this.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
  }
}

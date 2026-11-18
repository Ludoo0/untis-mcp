/**
 * On-disk file cache (spec 7): DATA_DIR/files/<sha256(ref)>.{bin,json}
 * TTL + size limit (oldest entries are evicted first). Caching errors are never fatal.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log";

export type CachedMeta = { name: string; mimeType: string; size: number; fetchedAt: number };

export class FileCache {
  constructor(
    private dir: string,
    private ttlMs = 24 * 3_600_000,
    private maxBytes = 500 * 1_048_576,
    private now: () => number = Date.now,
  ) {}

  private key(ref: string) {
    return createHash("sha256").update(ref).digest("hex");
  }

  get(ref: string): { meta: CachedMeta; data: Uint8Array } | undefined {
    const k = this.key(ref);
    try {
      const meta = JSON.parse(readFileSync(join(this.dir, `${k}.json`), "utf8")) as CachedMeta;
      if (this.now() - meta.fetchedAt > this.ttlMs) return undefined;
      return { meta, data: new Uint8Array(readFileSync(join(this.dir, `${k}.bin`))) };
    } catch {
      return undefined;
    }
  }

  put(ref: string, meta: Omit<CachedMeta, "fetchedAt">, data: Uint8Array) {
    if (data.byteLength > this.maxBytes) return;
    const k = this.key(ref);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${k}.bin`), data, { mode: 0o600 });
      writeFileSync(join(this.dir, `${k}.json`), JSON.stringify({ ...meta, fetchedAt: this.now() }), { mode: 0o600 });
      this.prune();
    } catch (e) {
      log.warn("File cache not writable", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Keeps the cache below maxBytes (deletes the oldest first). */
  private prune() {
    const entries = readdirSync(this.dir)
      .filter((f) => f.endsWith(".bin"))
      .map((f) => {
        const s = statSync(join(this.dir, f));
        return { base: f.slice(0, -4), size: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((n, e) => n + e.size, 0);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      rmSync(join(this.dir, `${e.base}.bin`), { force: true });
      rmSync(join(this.dir, `${e.base}.json`), { force: true });
      total -= e.size;
    }
  }
}

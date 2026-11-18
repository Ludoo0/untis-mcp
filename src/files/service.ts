/**
 * Download service (spec 5.11): fileRef → (resolver) → location → bytes, with disk cache.
 * Locations (signed storage URLs, WebUntis paths) never leave this class and are never logged.
 */
import type { FileCache } from "./cache";
import { resolveMimeType } from "./extract";

export type FileLocation = { name: string; location: string; mimeType?: string };
export type DownloadedFile = { ref: string; name: string; mimeType: string; data: Uint8Array; cached: boolean };

type Downloader = (
  pathOrUrl: string,
  maxBytes: number,
) => Promise<{ data: Uint8Array; contentType: string | null; disposition: string | null }>;

function nameFromDisposition(cd: string | null): string | undefined {
  if (!cd) return undefined;
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim().replace(/^"|"$/g, ""));
    } catch {}
  }
  return cd.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1]?.trim();
}

export class FileService {
  constructor(
    private download: Downloader,
    private opts: { maxBytes: number; cache?: FileCache },
  ) {}

  async get(ref: string, resolve: () => Promise<FileLocation>): Promise<DownloadedFile> {
    const hit = this.opts.cache?.get(ref);
    if (hit) return { ref, name: hit.meta.name, mimeType: hit.meta.mimeType, data: hit.data, cached: true };
    const loc = await resolve();
    const r = await this.download(loc.location, this.opts.maxBytes);
    const name = loc.name || nameFromDisposition(r.disposition) || "file";
    const mimeType = resolveMimeType(loc.mimeType ?? r.contentType, name);
    this.opts.cache?.put(ref, { name, mimeType, size: r.data.byteLength }, r.data);
    return { ref, name, mimeType, data: r.data, cached: false };
  }
}

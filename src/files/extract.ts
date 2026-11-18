/** Text extraction from files (spec 5.10): PDF (unpdf), DOCX (mammoth), text formats. */
import { log } from "../log";

const TEXT_MIME_RE = /^(text\/|application\/(json|xml|csv|x-csv|markdown|rtf))/i;
const TEXT_EXT_RE = /\.(txt|md|csv|json|xml|html?|rtf|tex)$/i;

export function extensionOf(name: string): string {
  return name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? "";
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  zip: "application/zip",
};

/** MIME type from the header; for generic types guess from the file extension. */
export function resolveMimeType(header: string | null, name: string): string {
  const h = (header ?? "").split(";")[0]!.trim().toLowerCase();
  if (h && h !== "application/octet-stream" && h !== "binary/octet-stream") return h;
  return MIME_BY_EXT[extensionOf(name)] ?? (h || "application/octet-stream");
}

export function canExtractText(mimeType: string, name: string): boolean {
  return mimeType === "application/pdf" || mimeType === MIME_BY_EXT.docx || TEXT_MIME_RE.test(mimeType) || TEXT_EXT_RE.test(name);
}

/** Returns the raw text (NOT redacted yet) or undefined. */
export async function extractText(data: Uint8Array, mimeType: string, name: string): Promise<string | undefined> {
  try {
    if (mimeType === "application/pdf") {
      const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { text } = await pdfText(pdf, { mergePages: true });
      return (Array.isArray(text) ? text.join("\n") : text).trim() || undefined;
    }
    if (mimeType === MIME_BY_EXT.docx || extensionOf(name) === "docx") {
      const mammoth = (await import("mammoth")).default;
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
      return value.trim() || undefined;
    }
    if (TEXT_MIME_RE.test(mimeType) || TEXT_EXT_RE.test(name)) {
      return new TextDecoder("utf-8", { fatal: false }).decode(data).trim() || undefined;
    }
  } catch (e) {
    log.warn("Text extraction failed", { mimeType, error: e instanceof Error ? e.name : "unknown" });
  }
  return undefined;
}

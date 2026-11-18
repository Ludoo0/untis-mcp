/**
 * untis_download_file (spec 5.11): resolves a fileRef statelessly and returns redacted text and/or the file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppContext } from "../context";
import { addDays } from "../dates";
import { ToolError } from "../errors";
import { canExtractText, extractText } from "../files/extract";
import { type FileRef, parseRef } from "../files/refs";
import type { FileLocation } from "../files/service";
import { log } from "../log";
import { redactFileName } from "../redaction/redactor";
import { messageAttachments } from "./messages";
import { handler } from "./result";
import { lessonDetailEntry } from "./timetable";

const unknownRef = () => new ToolError("FILE_REF_UNKNOWN", "This fileRef cannot be resolved (anymore) – fetch the list again.");
const unsupported = () =>
  new ToolError("NOT_A_FILE", "WebUntis does not provide a download location for this attachment (not supported yet).");

/** Relative WebUntis links ("/WebUntis/…") become paths for the session, absolute links stay. */
function location(urlOrPath: string | undefined): string | undefined {
  if (!urlOrPath) return undefined;
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  const m = urlOrPath.match(/^\/?WebUntis(\/.*)$/i);
  if (m) return m[1];
  return urlOrPath.startsWith("/") ? urlOrPath : undefined;
}

async function resolve(ctx: AppContext, ref: FileRef): Promise<FileLocation> {
  switch (ref.kind) {
    case "m": {
      const d = await ctx.untis.message(ref.messageId);
      const a = messageAttachments(d)[ref.n];
      if (!a) throw unknownRef();
      const name = a.name ?? "file";
      if (a.src === "blob") return { name, location: `/api/rest/view/v1/messages/${ref.messageId}/attachment` };
      const key = a.storageClientKey ?? (a.id !== undefined ? String(a.id) : undefined);
      if (!key) throw unsupported();
      const url = await ctx.untis.attachmentStorageUrl(key);
      if (!url) throw unsupported();
      return { name, location: url };
    }
    case "h": {
      const res = await ctx.untis.homeworksLegacy(addDays(ref.date, -1), addDays(ref.date, 1));
      const hw = res.data?.homeworks?.find((h) => h.id === ref.homeworkId);
      const a = hw?.attachments?.[ref.n];
      if (!a) throw unknownRef();
      const loc = location(a.url) ?? (a.id !== undefined ? `/api/homeworks/attachments/${a.id}` : undefined);
      if (!loc) throw unsupported();
      return { name: a.name ?? "file", location: loc };
    }
    case "d": {
      const res = await ctx.untis.messagesOfDay(ref.date);
      const a = res.data?.messagesOfDay?.[ref.n]?.attachments?.[ref.k];
      if (!a) throw unknownRef();
      const loc = location(a.url);
      if (!loc) throw unsupported();
      return { name: a.name ?? "file", location: loc };
    }
    case "l": {
      const { detail } = await lessonDetailEntry(ctx, ref.date, ref.periodId);
      const f = [...(detail?.teachingContentFiles ?? []), ...(detail?.notesAllFiles ?? [])][ref.n];
      if (!f) throw unknownRef();
      const loc = location(f.url ?? f.src);
      if (!loc) throw unsupported();
      return { name: f.name ?? f.fileName ?? "file", location: loc };
    }
  }
}

export const downloadFileInput = {
  fileRef: z.string().max(80).describe("fileRef from another tool"),
  mode: z
    .enum(["auto", "text", "blob", "both"])
    .default("auto")
    .describe("auto: PDF/DOCX/text as redacted text, images as image, other formats as file; text: text only; blob: file only; both"),
  maxTextChars: z.number().int().min(500).max(200_000).default(50_000),
};
type DownloadArgs = { fileRef: string; mode?: "auto" | "text" | "blob" | "both"; maxTextChars?: number };

export async function downloadFile(ctx: AppContext, args: DownloadArgs): Promise<CallToolResult> {
  const ref = parseRef(args.fileRef);
  if (!ref) throw unknownRef();
  const mode = args.mode ?? "auto";
  const maxText = args.maxTextChars ?? 50_000;
  const r = await ctx.files.get(args.fileRef, () => resolve(ctx, ref));

  const name = redactFileName(ctx.redactor, r.name);
  const isImage = r.mimeType.startsWith("image/");
  const wantText = mode === "text" || mode === "both" || (mode === "auto" && !isImage);
  let text: string | undefined;
  let textTruncated = false;
  if (wantText && canExtractText(r.mimeType, r.name)) {
    const raw = await extractText(r.data, r.mimeType, r.name);
    if (raw) {
      const full = ctx.redactor.text(raw);
      textTruncated = full.length > maxText;
      text = textTruncated ? `${full.slice(0, maxText)}…` : full;
    }
  }
  if (mode === "text" && text === undefined)
    throw new ToolError("NOT_A_FILE", `No text can be extracted from "${name}" (${r.mimeType}) – use mode "blob".`);
  const includeBlob = mode === "blob" || mode === "both" || (mode === "auto" && (isImage || text === undefined));

  let savedTo: string | undefined;
  if (ctx.cfg.downloadDir) {
    try {
      await mkdir(ctx.cfg.downloadDir, { recursive: true });
      savedTo = join(ctx.cfg.downloadDir, `${args.fileRef}_${name}`);
      await writeFile(savedTo, r.data);
    } catch (e) {
      savedTo = undefined;
      log.warn("Could not store file in DOWNLOAD_DIR", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const meta = {
    fileRef: args.fileRef,
    kind: isImage ? ("image" as const) : ("file" as const),
    name,
    mimeType: r.mimeType,
    sizeBytes: r.data.byteLength,
    cached: r.cached,
    textIncluded: text !== undefined,
    ...(text !== undefined ? { textChars: text.length, textTruncated } : {}),
    blobIncluded: includeBlob,
    ...(savedTo ? { savedTo } : {}),
  };
  const content: CallToolResult["content"] = [
    {
      type: "text",
      text:
        `File "${name}" (${meta.mimeType}, ${Math.ceil(meta.sizeBytes / 1024)} KB)${r.cached ? " from cache" : ""}.` +
        (includeBlob ? " Note: the file content itself is NOT redacted." : "") +
        (savedTo ? ` Saved to ${savedTo}.` : "") +
        `\n\n${JSON.stringify(meta, null, 2)}`,
    },
  ];
  if (text !== undefined) content.push({ type: "text", text: `--- Content (text, redacted) ---\n${text}` });
  if (includeBlob) {
    const b64 = Buffer.from(r.data).toString("base64");
    content.push(
      isImage
        ? { type: "image", data: b64, mimeType: r.mimeType }
        : { type: "resource", resource: { uri: `untis-file:${args.fileRef}`, mimeType: r.mimeType, blob: b64 } },
    );
  }
  return { content, structuredContent: { ...meta, ...(text !== undefined ? { text } : {}) } };
}

export function registerFileTools(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "untis_download_file",
    {
      title: "Download file",
      description:
        "Downloads an attachment by its fileRef (from messages, homework, messages of the day or lessons). Default (mode=auto): PDF/DOCX/text as redacted text (field `text`), images as image, other formats as file. Caution: images and files (blob) are NOT redacted – only extracted text is.",
      inputSchema: downloadFileInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(ctx, "untis_download_file", (args: DownloadArgs) => downloadFile(ctx, args)),
  );
}

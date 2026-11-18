import { z } from "zod";
import type { AppContext } from "../context";
import { addDays, checkRange, parseDateInput } from "../dates";
import type { FileRef } from "../files/refs";
import { formatRef } from "../files/refs";
import { redactFileName } from "../redaction/redactor";

export const dateInput = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "format YYYY-MM-DD")
    .optional()
    .describe(`${what} (YYYY-MM-DD, school time zone)`);

/** Resolves an optional range with defaults relative to today and validates it. */
export function resolveRange(
  ctx: AppContext,
  args: { startDate?: string; endDate?: string },
  defaults: { startOffset: number; endOffset: number },
  maxDays = ctx.cfg.maxRangeDays,
): { start: string; end: string } {
  const today = ctx.today();
  const start = parseDateInput(args.startDate, "startDate") ?? addDays(today, defaults.startOffset);
  const end =
    parseDateInput(args.endDate, "endDate") ??
    (args.startDate ? addDays(start, defaults.endOffset - defaults.startOffset) : addDays(today, defaults.endOffset));
  checkRange(start, end, maxDays);
  return { start, end };
}

export type FileRefDto = { fileRef: string; name: string; kind: "file" | "image" | "unknown" };

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;

export function fileRefDto(ctx: AppContext, ref: FileRef, name: string | null | undefined): FileRefDto {
  const n = redactFileName(ctx.redactor, name);
  return { fileRef: formatRef(ref), name: n, kind: IMAGE_RE.test(name ?? "") ? "image" : name ? "file" : "unknown" };
}

/** Drops undefined/empty-string properties (keeps DTOs small). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === "") delete o[k];
  return o;
}

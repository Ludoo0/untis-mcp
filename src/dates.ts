/** Date helpers. All dates are ISO "YYYY-MM-DD" strings in the school's time zone (TIMEZONE). */
import { ToolError } from "./errors";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Current local time "HH:MM" in the given time zone. */
export function nowTimeIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

const toUtc = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso: string, n: number) => fromUtc(toUtc(iso) + n * 86_400_000);
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
/** 0 = Monday … 6 = Sunday */
export const weekday = (iso: string) => (new Date(toUtc(iso)).getUTCDay() + 6) % 7;
export const mondayOf = (iso: string) => addDays(iso, -weekday(iso));

/** 20261118 → "2026-11-18" */
export function fromUntisDate(n: number | string | null | undefined): string | undefined {
  const s = String(n ?? "");
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : undefined;
}

/** 800 / "0800" / "T08:00" / "08:00" → "08:00" */
export function hhmm(v: number | string | null | undefined): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const digits = String(v).replace(/\D/g, "");
  if (!digits || digits.length > 4) return undefined;
  const p = digits.padStart(4, "0");
  return `${p.slice(0, 2)}:${p.slice(2, 4)}`;
}

/** Local date of an ISO date-time ("2026-11-18T08:00…" → "2026-11-18"). WebUntis sends local school time. */
export const dateOf = (dt: string | null | undefined) => (dt && ISO_DATE_RE.test(dt.slice(0, 10)) ? dt.slice(0, 10) : undefined);
/** Local time of an ISO date-time ("2026-11-18T08:00:00+01:00" → "08:00"). */
export const timeOf = (dt: string | null | undefined) => (dt && /T\d{2}:\d{2}/.test(dt) ? dt.slice(11, 16) : undefined);

/** Validates an input date (YYYY-MM-DD). */
export function parseDateInput(v: string | undefined, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (!ISO_DATE_RE.test(v) || Number.isNaN(toUtc(v)) || fromUtc(toUtc(v)) !== v) {
    throw new ToolError("INVALID_INPUT", `${field} must be a date in the format YYYY-MM-DD.`);
  }
  return v;
}

/** Validates a range: start ≤ end and at most maxDays days. */
export function checkRange(start: string, end: string, maxDays: number) {
  if (daysBetween(start, end) < 0) throw new ToolError("INVALID_INPUT", "endDate must not be before startDate.");
  if (daysBetween(start, end) + 1 > maxDays) throw new ToolError("RANGE_TOO_LARGE", `The date range is limited to ${maxDays} days.`);
}

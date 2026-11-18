/**
 * Central redaction pipeline for all free text (spec 6.4):
 * HTML → text, secret URLs, contact data, name dictionary, length limit.
 */
import { htmlToText, looksLikeHtml } from "./html";
import type { Labels } from "./labels";
import { redactContacts } from "./names";
import { PersonRegistry } from "./people";
import { stripSecretUrls } from "./secrets";

export class Redactor {
  constructor(readonly people: PersonRegistry = new PersonRegistry({ secret: "test-secret-not-for-production", scope: "test" })) {}

  get labels(): Labels {
    return this.people.labels;
  }

  /** Redacts free text (HTML or plain text). Empty input → "". */
  text(input: string | null | undefined, maxLen?: number): string {
    if (!input) return "";
    let s = looksLikeHtml(input) ? htmlToText(input, this.labels) : input.replace(/\r\n?/g, "\n").trim();
    s = stripSecretUrls(s, this.labels);
    s = redactContacts(s, this.labels);
    s = this.people.matcher().apply(s);
    return truncate(s, maxLen);
  }

  /** Short single-line texts (subjects, titles, file names). */
  title(input: string | null | undefined, maxLen = 300): string {
    return this.text(input, maxLen).replace(/\s*\n\s*/g, " ");
  }

  /** Optional free text: undefined if empty after redaction (keeps DTOs small). */
  optional(input: string | null | undefined, maxLen?: number): string | undefined {
    const s = this.text(input, maxLen);
    return s ? s : undefined;
  }
}

export function truncate(s: string, maxLen?: number): string {
  if (!maxLen || s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/** File names: redacted, without path characters. */
export function redactFileName(redactor: Redactor, name: string | null | undefined): string {
  const noControl = [...(name ?? "")].map((ch) => (ch.charCodeAt(0) < 0x20 ? "_" : ch)).join("");
  const cleaned = noControl.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return redactor.title(cleaned, 150) || "file";
}

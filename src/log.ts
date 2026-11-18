/**
 * Structured logging to stderr (with the stdio transport, stdout belongs to the MCP protocol).
 * Known secrets are replaced before output; URLs are reduced to patterns.
 * Content (texts, names) is never logged.
 */
import { redactUrlForLog } from "./redaction/secrets";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let minLevel: number = LEVELS.info;
const secrets = new Set<string>();

export function setLogLevel(level: LogLevel) {
  minLevel = LEVELS[level];
}

/** Registers a value that must never appear in the log (secret, password, JWT, API key). */
export function registerSecret(value: string | undefined) {
  if (value && value.length >= 6) secrets.add(value);
}

export function scrub(s: string): string {
  let out = s;
  for (const secret of secrets) out = out.split(secret).join("[secret]");
  return out
    .replace(/\b(?:https?|untis):\/\/[^\s"'<>\\]+/gi, (u) => redactUrlForLog(u))
    .replace(/\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, "[jwt]")
    .replace(/JSESSIONID=[^;\s"]+/gi, "JSESSIONID=[secret]");
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(`${scrub(line)}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

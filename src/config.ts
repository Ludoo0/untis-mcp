import { readFileSync } from "node:fs";
import { z } from "zod";
import { LANGUAGES, type Language } from "./redaction/labels";

export type Login = { kind: "secret"; secret: string } | { kind: "password"; password: string };

export type Config = {
  baseUrl: string;
  school: string;
  username: string;
  login: Login;
  transport: "stdio" | "http";
  host: string;
  port: number;
  allowedOrigins: string[];
  apiKey?: string;
  redactionLanguage: Language;
  redactionSecret?: string;
  redactionKeepWords: string[];
  redactTeachers: boolean;
  keepTeacherAbbreviations: boolean;
  absenceTexts: "redact" | "drop";
  timezone: string;
  maxRangeDays: number;
  maxFileMb: number;
  cacheTtlS: number;
  maxConcurrency: number;
  minRequestIntervalMs: number;
  dataDir: string;
  downloadDir?: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

export class ConfigError extends Error {
  constructor(public issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

/** Reads NAME or NAME_FILE (Docker secret, takes precedence). Empty values count as unset. */
function envValue(env: Env, name: string, readFile: ReadFile): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return readFile(file).trim() || undefined;
    } catch {
      throw new ConfigError([`${name}_FILE: file not readable (${file})`]);
    }
  }
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/WebUntis(\/.*)?$/i, "");
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withProto);
  if (u.pathname !== "/" && u.pathname !== "") throw new Error("must not contain a path");
  return `${u.protocol}//${u.host}`;
}

/** Untis Mobile QR code: untis://setschool?url=…&school=…&user=…&key=… */
export function parseQrUrl(qr: string): { baseUrl: string; school: string; username: string; secret: string } {
  let u: URL;
  try {
    u = new URL(qr.trim());
  } catch {
    throw new ConfigError(["UNTIS_QR_URL is not a valid URL (expected untis://setschool?url=…&school=…&user=…&key=…)"]);
  }
  const p = u.searchParams;
  const missing = ["url", "school", "user", "key"].filter((k) => !p.get(k));
  if (missing.length) throw new ConfigError([`UNTIS_QR_URL is missing: ${missing.join(", ")}`]);
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(p.get("url")!);
  } catch {
    throw new ConfigError(["UNTIS_QR_URL contains an invalid server url"]);
  }
  return { baseUrl, school: p.get("school")!, username: p.get("user")!, secret: p.get("key")! };
}

const BASE32_RE = /^[A-Z2-7]+=*$/i;

const boolish = z.enum(["true", "false", "1", "0", "yes", "no"]).transform((v) => v === "true" || v === "1" || v === "yes");
const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const schema = z.object({
  UNTIS_QR_URL: z.string().optional(),
  UNTIS_BASE_URL: z.string().optional(),
  UNTIS_SCHOOL: z.string().optional(),
  UNTIS_USERNAME: z.string().optional(),
  UNTIS_APP_SECRET: z.string().optional(),
  UNTIS_PASSWORD: z.string().optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HOST: z.string().default("127.0.0.1"),
  MCP_PORT: intIn(1, 65535).default(3000),
  MCP_ALLOWED_ORIGINS: z.string().default(""),
  MCP_API_KEY: z.string().min(32, "MCP_API_KEY must be at least 32 characters long").optional(),
  REDACTION_LANGUAGE: z
    .enum(LANGUAGES as [Language, ...Language[]], { error: `REDACTION_LANGUAGE must be one of ${LANGUAGES.join(", ")}` })
    .default("de"),
  REDACTION_SECRET: z.string().min(16, "REDACTION_SECRET must be at least 16 characters long").optional(),
  REDACTION_KEEP_WORDS: z.string().default(""),
  REDACT_TEACHERS: boolish.default(false),
  KEEP_TEACHER_ABBREVIATIONS: boolish.default(true),
  ABSENCE_TEXTS: z.enum(["redact", "drop"]).default("redact"),
  TIMEZONE: z.string().default("Europe/Berlin"),
  MAX_RANGE_DAYS: intIn(1, 366).default(31),
  MAX_FILE_MB: intIn(1, 500).default(25),
  CACHE_TTL_S: intIn(0, 3600).default(60),
  MAX_CONCURRENCY: intIn(1, 8).default(2),
  MIN_REQUEST_INTERVAL_MS: intIn(0, 10_000).default(200),
  DATA_DIR: z.string().default("/data"),
  DOWNLOAD_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const KEYS = Object.keys(schema.shape) as (keyof typeof schema.shape)[];

export function loadConfig(env: Env = process.env, readFile: ReadFile = (p) => readFileSync(p, "utf8")): Config {
  const raw: Record<string, string | undefined> = {};
  for (const k of KEYS) raw[k] = envValue(env, k, readFile);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => (i.message.includes(String(i.path[0])) ? i.message : `${String(i.path[0])}: ${i.message}`)),
    );
  }
  const c = parsed.data;
  const issues: string[] = [];

  let baseUrl = "";
  let school = c.UNTIS_SCHOOL ?? "";
  let username = c.UNTIS_USERNAME ?? "";
  let login: Login | undefined;

  const variants = [c.UNTIS_QR_URL, c.UNTIS_APP_SECRET, c.UNTIS_PASSWORD].filter(Boolean).length;
  if (variants === 0) issues.push("No login configured: set UNTIS_QR_URL, or UNTIS_APP_SECRET, or UNTIS_PASSWORD");
  if (variants > 1) issues.push("Configure exactly one login variant: UNTIS_QR_URL, UNTIS_APP_SECRET or UNTIS_PASSWORD");

  if (c.UNTIS_QR_URL) {
    const qr = parseQrUrl(c.UNTIS_QR_URL);
    baseUrl = qr.baseUrl;
    school = qr.school;
    username = qr.username;
    login = { kind: "secret", secret: qr.secret };
  } else {
    if (!c.UNTIS_BASE_URL) issues.push("UNTIS_BASE_URL is missing");
    else {
      try {
        baseUrl = normalizeBaseUrl(c.UNTIS_BASE_URL);
      } catch (e) {
        issues.push(`UNTIS_BASE_URL is invalid: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!school) issues.push("UNTIS_SCHOOL is missing");
    if (!username) issues.push("UNTIS_USERNAME is missing");
    if (c.UNTIS_APP_SECRET) login = { kind: "secret", secret: c.UNTIS_APP_SECRET };
    else if (c.UNTIS_PASSWORD) login = { kind: "password", password: c.UNTIS_PASSWORD };
  }
  if (login?.kind === "secret" && !BASE32_RE.test(login.secret.replace(/[\s-]/g, ""))) {
    issues.push("The app secret is not valid Base32 (letters A–Z and digits 2–7)");
  }
  if (c.MCP_TRANSPORT === "http" && !c.MCP_API_KEY) issues.push("MCP_API_KEY is required when MCP_TRANSPORT=http");
  try {
    new Intl.DateTimeFormat("en", { timeZone: c.TIMEZONE });
  } catch {
    issues.push("TIMEZONE is not a valid IANA time zone (e.g. Europe/Berlin)");
  }
  if (issues.length || !login) throw new ConfigError(issues);

  return {
    baseUrl,
    school,
    username,
    login,
    transport: c.MCP_TRANSPORT,
    host: c.MCP_HOST,
    port: c.MCP_PORT,
    allowedOrigins: list(c.MCP_ALLOWED_ORIGINS),
    apiKey: c.MCP_API_KEY,
    redactionLanguage: c.REDACTION_LANGUAGE,
    redactionSecret: c.REDACTION_SECRET,
    redactionKeepWords: list(c.REDACTION_KEEP_WORDS).map((w) => w.toLowerCase()),
    redactTeachers: c.REDACT_TEACHERS,
    keepTeacherAbbreviations: c.KEEP_TEACHER_ABBREVIATIONS,
    absenceTexts: c.ABSENCE_TEXTS,
    timezone: c.TIMEZONE,
    maxRangeDays: c.MAX_RANGE_DAYS,
    maxFileMb: c.MAX_FILE_MB,
    cacheTtlS: c.CACHE_TTL_S,
    maxConcurrency: c.MAX_CONCURRENCY,
    minRequestIntervalMs: c.MIN_REQUEST_INTERVAL_MS,
    dataDir: c.DATA_DIR,
    downloadDir: c.DOWNLOAD_DIR,
    logLevel: c.LOG_LEVEL,
  };
}

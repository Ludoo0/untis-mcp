/**
 * Detection and removal of secrets and WebUntis-internal URLs (spec 6.5).
 */
import { LABELS, type Labels } from "./labels";

/** WebUntis/Untis hosts – links to them are never handed to agents (session-bound, may contain ids/tokens). */
const UNTIS_HOST_RE = /(^|\.)(webuntis\.com|untis\.(at|com|de|cloud)|untis-cloud\.\w+)$/i;
/** Object storage of attachments (signed URLs). */
const STORAGE_HOST_RE = /(amazonaws\.com|blob\.core\.windows\.net|googleapis\.com|storage\.googleapis\.com|digitaloceanspaces\.com)$/i;
const SECRET_PARAM_RE =
  /^(token|key|secret|signature|sig|sign|hash|jwt|otp|access_token|refresh_token|password|pw|user|username|email|personid|studentid|userid|x-amz-[\w-]+|se|sp|sv|sr|st)$/i;
const URL_IN_TEXT_RE = /\b(?:https?|untis):\/\/[^\s<>"'`)\]]+/gi;
const ID_KEY_RE = /\b(?:Person|User|Student|Teacher|Elem|Element)_?Id\b/i;
const MAX_PARAM_VALUE_LEN = 200;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function isUntisUrl(url: string): boolean {
  const u = parse(url);
  return !!u && (u.protocol === "untis:" || UNTIS_HOST_RE.test(u.hostname));
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hasSecretParams(u: URL): boolean {
  for (const [k, v] of u.searchParams) {
    if (SECRET_PARAM_RE.test(k)) return true;
    if (v.length > MAX_PARAM_VALUE_LEN || /[{}"<>]/.test(v) || ID_KEY_RE.test(v)) return true;
  }
  const hash = safeDecode(u.hash);
  return hash.length > MAX_PARAM_VALUE_LEN || /[{}"<>]/.test(hash) || ID_KEY_RE.test(hash);
}

/**
 * May this URL be passed to an agent?
 * Only external http(s) links without secret/suspicious parameters. Never WebUntis or storage hosts.
 */
export function isShareableUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (UNTIS_HOST_RE.test(u.hostname) || STORAGE_HOST_RE.test(u.hostname)) return false;
  if (u.username || u.password) return false;
  return !hasSecretParams(u);
}

/** Relative WebUntis links, e.g. "/WebUntis/api/…" or "jsonrpc.do?school=…". */
const RELATIVE_UNTIS_PATH_RE = /(?<![\w/.:-])\/?WebUntis\/[^\s<>"'`)\]]*/gi;
/** Internal ids as key/value pairs, e.g. "personId=123", "\"studentId\": 5". */
const ID_PAIR_RE = /["']?\b(?:Person|User|Student|Elem|Element)_?Id["']?\s*[=:]\s*["']?\d+["']?/gi;
/** URL-encoded data blobs – names encoded inside are invisible to the name dictionary. */
const ENCODED_BLOB_RE = /[^\s<>"']*(?:%[0-9a-f]{2}[^\s<>"'%]*){3,}/gi;
/** JWT-like tokens. */
const JWT_RE = /\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g;

/** Replaces non-shareable URLs, encoded data blobs, JWTs and internal id pairs. External, harmless links are kept. */
export function stripSecretUrls(text: string, labels: Labels = LABELS.en): string {
  return text
    .replace(ENCODED_BLOB_RE, (raw) => (isShareableUrl(raw) ? raw : labels.encodedData))
    .replace(URL_IN_TEXT_RE, (raw) => {
      const url = raw.replace(/[.,;:!?]+$/, "");
      const tail = raw.slice(url.length);
      if (isShareableUrl(url)) return raw;
      return (isUntisUrl(url) ? labels.untisLink : labels.linkRemoved) + tail;
    })
    .replace(RELATIVE_UNTIS_PATH_RE, (raw) => labels.untisLink + (raw.match(/[.,;:!?]+$/)?.[0] ?? ""))
    .replace(JWT_RE, labels.linkRemoved)
    .replace(ID_PAIR_RE, labels.idPair);
}

function redactSegment(seg: string): string {
  if (!seg) return seg;
  const s = safeDecode(seg);
  if (/^\d+$/.test(s)) return "{n}";
  if (/^v\d{1,2}$/i.test(s)) return s;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return "{guid}";
  if (/^[\w-]+\.(do|html?|json)$/i.test(s)) return s;
  const ext = s.match(/\.([a-z0-9]{1,5})$/i);
  if (ext) return `{file}.${ext[1]!.toLowerCase()}`;
  if (s.length > 24 || /[^\w.-]/.test(s) || (/\d/.test(s) && /[a-z]/i.test(s))) return "{token}";
  return s;
}

/** URL pattern for logs: ids, tokens, file names and all query values replaced; the school host becomes <school>. */
export function redactUrlForLog(raw: string): string {
  const u = parse(raw);
  if (!u) return "{unparseable}";
  if (u.protocol === "untis:") return "untis://{redacted}";
  if (STORAGE_HOST_RE.test(u.hostname)) return "{storage-url}";
  if (!UNTIS_HOST_RE.test(u.hostname)) return "{external-url}";
  const host = /\.webuntis\.com$/i.test(u.hostname) && !/^(mobile|images)\./i.test(u.hostname) ? "<school>.webuntis.com" : u.host;
  const path = u.pathname.split("/").map(redactSegment).join("/");
  const keys = [...new Set(u.searchParams.keys())];
  const qs = keys.length ? `?${keys.map((k) => `${k}={${/^\d+$/.test(u.searchParams.get(k) ?? "") ? "n" : "v"}}`).join("&")}` : "";
  return `${u.protocol}//${host}${path}${qs}`;
}

/** Cleans API error texts for logs (they may contain ids or names). */
export function sanitizeErrorText(text: string): string {
  if (/<html|<!DOCTYPE/i.test(text)) return "HTML page";
  return text
    .replace(URL_IN_TEXT_RE, (u) => redactUrlForLog(u))
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "{email}")
    .replace(/\d+/g, "{n}")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

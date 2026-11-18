/**
 * Shared helpers for the developer scripts (scripts/):
 * terminal input, TOTP, login (app secret or password), JSON-RPC and REST client.
 *
 * Never log anything returned by these helpers – secrets and personal data pass through here.
 */

import { readHidden, readLine } from "../src/cli/prompt";

export { readHidden, readLine };

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) untis-mcp-probe";

// ---------- Configuration ----------

export type Credentials = {
  /** e.g. https://yourschool.webuntis.com (no path) */
  baseUrl: string;
  /** School login name (loginName from the school search, `school=` in the QR code) */
  school: string;
  username: string;
} & ({ kind: "secret"; secret: string } | { kind: "password"; password: string });

export function normalizeBase(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/WebUntis.*$/i, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Parses the Untis Mobile QR code: untis://setschool?url=…&school=…&user=…&key=… */
export function parseQrUrl(qr: string): { baseUrl: string; school: string; username: string; secret: string } {
  const u = new URL(qr.trim());
  const p = u.searchParams;
  const baseUrl = normalizeBase(p.get("url") ?? "");
  const school = p.get("school") ?? "";
  const username = p.get("user") ?? "";
  const secret = p.get("key") ?? "";
  if (!baseUrl || !school || !username || !secret) throw new Error("QR code URL is missing url, school, user or key.");
  return { baseUrl, school, username, secret };
}

const env = (name: string) => process.env[name]?.trim() || "";

/** Reads the credentials from UNTIS_* variables (Bun loads .env) or asks interactively. */
export async function loadCredentials(): Promise<Credentials> {
  const qr = env("UNTIS_QR_URL");
  if (qr) return { kind: "secret", ...parseQrUrl(qr) };

  let baseUrl = normalizeBase(env("UNTIS_BASE_URL"));
  let school = env("UNTIS_SCHOOL");
  let username = env("UNTIS_USERNAME");
  const secret = env("UNTIS_APP_SECRET");
  const password = env("UNTIS_PASSWORD");

  if (!baseUrl && !secret && !password) {
    const answer = await readHidden("Paste the Untis Mobile QR code URL (untis://setschool?…), or press Enter to skip: ");
    if (answer.trim()) return { kind: "secret", ...parseQrUrl(answer) };
  }
  if (!baseUrl) baseUrl = normalizeBase(await readLine("WebUntis server (e.g. yourschool.webuntis.com): "));
  if (!school) school = await readLine("School login name: ");
  if (!username) username = await readLine("Username: ");
  if (!baseUrl || !school || !username) throw new Error("Server, school and username are required.");
  if (secret) return { kind: "secret", baseUrl, school, username, secret };
  if (password) return { kind: "password", baseUrl, school, username, password };
  const typed = await readHidden("App secret (or leave empty to use a password): ");
  if (typed.trim()) return { kind: "secret", baseUrl, school, username, secret: typed.trim() };
  const pw = await readHidden("Password: ");
  if (!pw) throw new Error("An app secret or a password is required.");
  return { kind: "password", baseUrl, school, username, password: pw };
}

// ---------- TOTP (RFC 6238: SHA-1, 30 s, 6 digits, Base32 secret) ----------

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("App secret is not valid Base32.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totp(secret: string, timeMs = Date.now(), stepS = 30, digits = 6): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / stepS);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

// ---------- Cookie jar ----------

export class CookieJar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  set(name: string, value: string) {
    this.cookies.set(name, value);
  }
  has(name: string) {
    return this.cookies.has(name);
  }
  names() {
    return [...this.cookies.keys()];
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  clear() {
    this.cookies.clear();
  }
}

// ---------- Session ----------

export type RpcResult<T = unknown> =
  | { ok: true; result: T; status: number }
  | { ok: false; status: number; code?: number; message: string };

export class UntisSession {
  readonly jar = new CookieJar();
  private jwt: string | undefined;
  private jwtExpiresAt = 0;
  /** Raw login result (getUserData2017 or authenticate) – contains personal data, never log it. */
  loginResult: any;

  constructor(readonly creds: Credentials) {}

  get base() {
    return this.creds.baseUrl;
  }

  private schoolQuery() {
    return `school=${encodeURIComponent(this.creds.school)}`;
  }

  async authParam() {
    if (this.creds.kind !== "secret") throw new Error("authParam() needs an app secret.");
    const clientTime = Date.now();
    return { user: this.creds.username, otp: await totp(this.creds.secret, clientTime), clientTime };
  }

  private async post(url: string, body: unknown): Promise<Response> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, Cookie: this.jar.header() },
      body: JSON.stringify(body),
    });
    this.jar.store(res);
    return res;
  }

  private static async parseRpc(res: Response): Promise<RpcResult> {
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, message: `not JSON (${res.headers.get("content-type")}, ${text.length} bytes)` };
    }
    if (json?.error) return { ok: false, status: res.status, code: json.error.code, message: String(json.error.message ?? "") };
    return { ok: true, status: res.status, result: json?.result };
  }

  /** Login with app secret (jsonrpc_intern.do getUserData2017) or password (jsonrpc.do authenticate). */
  async login(): Promise<RpcResult> {
    this.jar.clear();
    this.jar.set("schoolname", `"_${Buffer.from(this.creds.school).toString("base64")}"`);
    this.jwt = undefined;
    let r: RpcResult;
    if (this.creds.kind === "secret") {
      r = await this.rpcIntern("getUserData2017", { elementId: 0, deviceOs: "AND", deviceOsVersion: "" });
    } else {
      r = await this.rpc("authenticate", { user: this.creds.username, password: this.creds.password, client: "untis-mcp-probe" });
    }
    if (r.ok) this.loginResult = r.result;
    return r;
  }

  /** Public/legacy JSON-RPC API (session cookie). */
  async rpc(method: string, params: unknown = {}): Promise<RpcResult> {
    const res = await this.post(`${this.base}/WebUntis/jsonrpc.do?${this.schoolQuery()}`, { id: method, method, params, jsonrpc: "2.0" });
    return UntisSession.parseRpc(res);
  }

  /** Internal mobile-app JSON-RPC API; every call carries a fresh TOTP auth object. */
  async rpcIntern(method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
    const auth = await this.authParam();
    const res = await this.post(`${this.base}/WebUntis/jsonrpc_intern.do?m=${method}&${this.schoolQuery()}&v=i2.2`, {
      id: method,
      method,
      params: [{ ...params, auth }],
      jsonrpc: "2.0",
    });
    return UntisSession.parseRpc(res);
  }

  /** GET /WebUntis/api/token/new → JWT for the REST API. */
  async fetchJwt(): Promise<{ status: number; token?: string }> {
    const res = await fetch(`${this.base}/WebUntis/api/token/new`, {
      headers: { "User-Agent": UA, Cookie: this.jar.header() },
      redirect: "manual",
    });
    this.jar.store(res);
    const text = (await res.text()).trim();
    if (!res.ok || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(text)) return { status: res.status };
    this.jwt = text;
    const exp = decodeJwtPayload(text)?.exp;
    this.jwtExpiresAt = typeof exp === "number" ? exp * 1000 : Date.now() + 10 * 60_000;
    return { status: res.status, token: text };
  }

  /** Request against /WebUntis/… with cookie + bearer token (refreshed before expiry). */
  async request(path: string, init: { method?: string; body?: unknown; bearer?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": UA, Cookie: this.jar.header() };
    if (init.bearer !== false) {
      if (!this.jwt || Date.now() > this.jwtExpiresAt - 60_000) await this.fetchJwt();
      if (this.jwt) headers.Authorization = `Bearer ${this.jwt}`;
    }
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
    this.jar.store(res);
    return res;
  }

  async logout() {
    try {
      await this.rpc("logout", {});
    } catch {
      /* ignore */
    }
  }
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  try {
    const part = jwt.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

// ---------- Dates ----------

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const untisDate = (d: Date) => Number(isoDate(d).replace(/-/g, ""));
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

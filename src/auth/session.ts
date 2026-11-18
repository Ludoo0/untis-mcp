/**
 * WebUntis session (spec 4): login via app secret (TOTP, jsonrpc_intern getUserData2017) or password
 * (jsonrpc authenticate), cookie jar, JWT for the REST view API, re-login, retries, rate limiting.
 *
 * Secrets (secret, password, JSESSIONID, JWT, TOTP codes) never leave this class and are registered with the logger.
 */
import { Limiter } from "../api/limiter";
import type { Login } from "../config";
import { ToolError } from "../errors";
import { log, registerSecret } from "../log";
import { sanitizeErrorText } from "../redaction/secrets";
import { totp } from "./totp";

export type SessionOptions = {
  baseUrl: string;
  school: string;
  username: string;
  login: Login;
  fetchImpl?: typeof fetch;
  limiter?: Limiter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  clientName?: string;
};

type RpcResponse = { result?: unknown; error?: { code?: number; message?: string } };

const UA = "untis-mcp (read-only)";
const MAX_ATTEMPTS = 3;
const JWT_MARGIN_MS = 60_000;

/** JSON-RPC error codes (docs/untis-api.md → errors) */
const RPC_NOT_AUTHENTICATED = -8520;
const RPC_BAD_CREDENTIALS = -8504;
const RPC_NO_RIGHT = -8509;
const RPC_OUT_OF_RANGE = -7004;

export class RpcError extends Error {
  constructor(
    public code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function mapRpcError(e: RpcError): ToolError {
  if (e.code === RPC_NO_RIGHT) return new ToolError("NO_RIGHT", "The account has no right to read this data in WebUntis.");
  if (e.code === RPC_OUT_OF_RANGE)
    return new ToolError("OUT_OF_RANGE", "The date is outside the range WebUntis allows (e.g. outside the school year).");
  if (e.code === RPC_NOT_AUTHENTICATED) return new ToolError("AUTH_FAILED", "The WebUntis session could not be established.");
  log.warn("WebUntis JSON-RPC error", { code: e.code, message: sanitizeErrorText(e.message) });
  return new ToolError("UPSTREAM_ERROR", "WebUntis returned an error.");
}

function mapHttpStatus(status: number, body: string): ToolError {
  if (status === 401) return new ToolError("AUTH_FAILED", "WebUntis rejected the session.", status);
  if (status === 403) return new ToolError("NO_RIGHT", "The account has no right to read this data in WebUntis.", status);
  if (status === 404) return new ToolError("NOT_FOUND", "Not found in WebUntis.", status);
  if (status === 429) return new ToolError("RATE_LIMITED", "WebUntis is throttling requests – try again later.", status);
  log.warn("WebUntis HTTP error", { status, body: sanitizeErrorText(body) });
  return new ToolError("UPSTREAM_ERROR", "WebUntis is not reachable or returned an error.", status);
}

export class UntisSession {
  private cookies = new Map<string, string>();
  private jwt?: { token: string; expiresAt: number };
  private loginPromise?: Promise<void>;
  private loggedIn = false;
  private fatal?: ToolError;
  private fetchImpl: typeof fetch;
  private limiter: Limiter;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private host: string;
  /** Raw result of the last login (getUserData2017 / authenticate) – contains personal data, never log it. */
  loginResult: unknown;

  constructor(private opts: SessionOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter ?? new Limiter(2, 200);
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = opts.now ?? Date.now;
    this.host = new URL(opts.baseUrl).host;
    registerSecret(opts.login.kind === "secret" ? opts.login.secret : opts.login.password);
  }

  get baseUrl() {
    return this.opts.baseUrl;
  }

  private schoolQuery() {
    return `school=${encodeURIComponent(this.opts.school)}`;
  }

  // ---------- HTTP basics ----------

  private cookieHeader(url: string): string | undefined {
    if (new URL(url).host !== this.host || this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(url: string, res: Response) {
    if (new URL(url).host !== this.host) return;
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      this.cookies.set(name, value);
      if (name === "JSESSIONID") registerSecret(value);
    }
  }

  /** fetch with limiter, cookies and retries (429/5xx/network). Redirects are never followed automatically. */
  private async send(url: string, init: RequestInit = {}, opts: { cookies?: boolean } = {}): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const headers = new Headers(init.headers);
        headers.set("User-Agent", UA);
        if (!headers.has("Accept")) headers.set("Accept", "application/json");
        const cookie = opts.cookies === false ? undefined : this.cookieHeader(url);
        if (cookie) headers.set("Cookie", cookie);
        const res = await this.limiter.run(() => this.fetchImpl(url, { ...init, headers, redirect: "manual" }));
        if (opts.cookies !== false) this.storeCookies(url, res);
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(res.headers.get("retry-after"));
          await res.body?.cancel().catch(() => {});
          await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** (attempt - 1));
          continue;
        }
        return res;
      } catch (e) {
        lastError = e;
        if (attempt < MAX_ATTEMPTS) await this.sleep(500 * 2 ** (attempt - 1));
      }
    }
    log.warn("WebUntis not reachable", { error: lastError instanceof Error ? lastError.name : "unknown" });
    throw new ToolError("UPSTREAM_ERROR", "WebUntis is not reachable.");
  }

  private async postRpc(url: string, method: string, params: unknown): Promise<unknown> {
    const res = await this.send(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: method, method, params, jsonrpc: "2.0" }),
    });
    const text = await res.text();
    if (!res.ok) throw mapHttpStatus(res.status, text);
    let json: RpcResponse;
    try {
      json = JSON.parse(text) as RpcResponse;
    } catch {
      throw mapHttpStatus(502, text);
    }
    if (json.error) throw new RpcError(json.error.code, String(json.error.message ?? ""));
    this.checkClock(res);
    return json.result;
  }

  private clockChecked = false;
  private checkClock(res: Response) {
    if (this.clockChecked) return;
    const date = Date.parse(res.headers.get("date") ?? "");
    if (!Number.isFinite(date)) return;
    this.clockChecked = true;
    const skew = Math.abs(this.now() - date);
    if (skew > 30_000) log.warn("System clock differs from WebUntis – TOTP login may fail", { skewSeconds: Math.round(skew / 1000) });
  }

  // ---------- Login ----------

  async ensureLogin(): Promise<void> {
    if (this.fatal) throw this.fatal;
    if (this.loggedIn) return;
    await this.login();
  }

  /** Single flight: parallel callers wait for the same login. */
  login(): Promise<void> {
    if (this.fatal) return Promise.reject(this.fatal);
    this.loginPromise ??= this.doLogin().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async doLogin() {
    this.loggedIn = false;
    this.jwt = undefined;
    this.cookies.clear();
    this.cookies.set("schoolname", `"_${Buffer.from(this.opts.school).toString("base64")}"`);
    try {
      if (this.opts.login.kind === "secret") {
        try {
          this.loginResult = await this.internRaw("getUserData2017", { elementId: 0, deviceOs: "AND", deviceOsVersion: "" });
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
          // One retry with the next TOTP code (code may have expired in transit)
          await this.sleep(1_500);
          this.loginResult = await this.internRaw("getUserData2017", { elementId: 0, deviceOs: "AND", deviceOsVersion: "" });
        }
      } else {
        this.loginResult = await this.postRpc(`${this.baseUrl}/WebUntis/jsonrpc.do?${this.schoolQuery()}`, "authenticate", {
          user: this.opts.username,
          password: this.opts.login.password,
          client: this.opts.clientName ?? "untis-mcp",
        });
      }
    } catch (e) {
      if (e instanceof RpcError) {
        this.fatal = await this.loginFailure(e);
        log.error("WebUntis login failed permanently – no further attempts until restart", { code: this.fatal.code, rpcCode: e.code });
        throw this.fatal;
      }
      throw e;
    }
    if (!this.cookies.has("JSESSIONID")) log.warn("WebUntis login returned no session cookie");
    this.loggedIn = true;
    log.info("Logged in to WebUntis", { via: this.opts.login.kind });
  }

  private async loginFailure(e: RpcError): Promise<ToolError> {
    if (this.opts.login.kind === "password" && e.code === RPC_BAD_CREDENTIALS && (await this.instanceUsesSso())) {
      return new ToolError(
        "SSO_ACCOUNT_NEEDS_SECRET",
        "Password login failed and this school uses single sign-on. Use the Untis Mobile QR code (WebUntis → profile → sharing) via UNTIS_QR_URL instead.",
        undefined,
        true,
      );
    }
    return new ToolError(
      "AUTH_FAILED",
      this.opts.login.kind === "secret"
        ? "WebUntis rejected the app secret (QR code). Create a new QR code in WebUntis, update the configuration and restart."
        : "WebUntis rejected the username or password. Fix the configuration and restart.",
      undefined,
      true,
    );
  }

  /** Reads loginServiceConfig from the public login page (spec 4.1). */
  private async instanceUsesSso(): Promise<boolean> {
    try {
      const res = await this.send(
        `${this.baseUrl}/WebUntis/?${this.schoolQuery()}`,
        { headers: { Accept: "text/html" } },
        { cookies: false },
      );
      const html = await res.text();
      return /"ssoOidc"\s*:\s*true/.test(html) || /"ssoOffice365"\s*:\s*true/.test(html) || /"ssoSamlProviders"\s*:\s*\[\s*\{/.test(html);
    } catch {
      return false;
    }
  }

  async logout() {
    if (!this.loggedIn) return;
    try {
      await this.postRpc(`${this.baseUrl}/WebUntis/jsonrpc.do?${this.schoolQuery()}`, "logout", {});
    } catch {
      /* ignore */
    }
    this.loggedIn = false;
  }

  /** Runs `fn`; on an expired session: one re-login and one retry. */
  private async withSession<T>(fn: () => Promise<T>, isExpired: (e: unknown) => boolean): Promise<T> {
    await this.ensureLogin();
    try {
      return await fn();
    } catch (e) {
      if (!isExpired(e)) throw e;
      log.info("WebUntis session expired – logging in again");
      this.loggedIn = false;
      await this.login();
      return fn();
    }
  }

  // ---------- API families ----------

  /** Public JSON-RPC API (jsonrpc.do) */
  async rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    try {
      return (await this.withSession(
        () => this.postRpc(`${this.baseUrl}/WebUntis/jsonrpc.do?${this.schoolQuery()}`, method, params),
        (e) => e instanceof RpcError && e.code === RPC_NOT_AUTHENTICATED,
      )) as T;
    } catch (e) {
      throw e instanceof RpcError ? mapRpcError(e) : e;
    }
  }

  private async internRaw(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.opts.login.kind !== "secret") throw new ToolError("NO_RIGHT", "This data needs the app secret login (UNTIS_QR_URL).");
    const clientTime = this.now();
    const otp = await totp(this.opts.login.secret, clientTime);
    return this.postRpc(`${this.baseUrl}/WebUntis/jsonrpc_intern.do?m=${encodeURIComponent(method)}&${this.schoolQuery()}&v=i2.2`, method, [
      { ...params, auth: { user: this.opts.username, otp, clientTime } },
    ]);
  }

  /** Internal mobile-app API (jsonrpc_intern.do) – every call carries a fresh TOTP. */
  async intern<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await this.withSession(
        () => this.internRaw(method, params),
        (e) => e instanceof RpcError && e.code === RPC_NOT_AUTHENTICATED,
      )) as T;
    } catch (e) {
      throw e instanceof RpcError ? mapRpcError(e) : e;
    }
  }

  get hasIntern() {
    return this.opts.login.kind === "secret";
  }

  /** Legacy REST API (/WebUntis/api/…, session cookie). */
  async legacy<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}/WebUntis${path}`;
    return this.withSession(
      async () => {
        const res = await this.send(url);
        const text = await res.text();
        if (res.status >= 300 && res.status < 400) throw new SessionExpired();
        if (!res.ok) throw mapHttpStatus(res.status, text);
        try {
          return JSON.parse(text) as T;
        } catch {
          // An HTML login page instead of JSON = session gone
          if (/<html/i.test(text)) throw new SessionExpired();
          throw mapHttpStatus(502, text);
        }
      },
      (e) => e instanceof SessionExpired,
    ).catch((e) => {
      throw e instanceof SessionExpired ? new ToolError("AUTH_FAILED", "The WebUntis session could not be established.") : e;
    });
  }

  private async token(): Promise<string> {
    if (this.jwt && this.now() < this.jwt.expiresAt - JWT_MARGIN_MS) return this.jwt.token;
    const res = await this.send(`${this.baseUrl}/WebUntis/api/token/new`, { headers: { Accept: "*/*" } });
    const text = (await res.text()).trim();
    if (res.status >= 300 && res.status < 400) throw new SessionExpired();
    if (!res.ok || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(text)) throw mapHttpStatus(res.ok ? 502 : res.status, "");
    registerSecret(text);
    let expiresAt = this.now() + 10 * 60_000;
    try {
      const payload = JSON.parse(Buffer.from(text.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
      if (typeof payload.exp === "number") expiresAt = payload.exp * 1000;
    } catch {}
    this.jwt = { token: text, expiresAt };
    return text;
  }

  /** REST view API (/WebUntis/api/rest/view/…, bearer JWT + cookie). */
  async rest<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}/WebUntis${path}`;
    return this.withSession(
      async () => {
        const res = await this.send(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
        const text = await res.text();
        if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
          this.jwt = undefined;
          throw new SessionExpired();
        }
        if (!res.ok) throw mapHttpStatus(res.status, text);
        try {
          return JSON.parse(text) as T;
        } catch {
          throw mapHttpStatus(502, text);
        }
      },
      (e) => e instanceof SessionExpired,
    ).catch((e) => {
      throw e instanceof SessionExpired ? new ToolError("AUTH_FAILED", "The WebUntis session could not be established.") : e;
    });
  }

  /**
   * Binary download. WebUntis paths ("/…") get cookie + bearer, absolute URLs (signed storage links) get nothing.
   * Returns the response with a size limit; redirects are followed manually (max. 5, no credentials to other hosts).
   */
  async download(
    pathOrUrl: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; contentType: string | null; disposition: string | null }> {
    await this.ensureLogin();
    let url = pathOrUrl.startsWith("/") ? `${this.baseUrl}/WebUntis${pathOrUrl}` : pathOrUrl;
    for (let hop = 0; hop < 6; hop++) {
      const own = new URL(url).host === this.host;
      const headers: Record<string, string> = { Accept: "*/*" };
      if (own) headers.Authorization = `Bearer ${await this.token()}`;
      const res = await this.send(url, { headers }, { cookies: own });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        url = new URL(res.headers.get("location")!, url).toString();
        continue;
      }
      if (!res.ok) throw mapHttpStatus(res.status, "");
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new ToolError("FILE_TOO_LARGE", `The file is larger than the limit (${Math.round(length / 1_048_576)} MB).`);
      }
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.byteLength > maxBytes)
        throw new ToolError("FILE_TOO_LARGE", `The file is larger than the limit (${Math.round(data.byteLength / 1_048_576)} MB).`);
      return { data, contentType: res.headers.get("content-type"), disposition: res.headers.get("content-disposition") };
    }
    throw new ToolError("UPSTREAM_ERROR", "Too many redirects while downloading the file.");
  }
}

class SessionExpired extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpired";
  }
}

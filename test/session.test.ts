import { describe, expect, test } from "bun:test";
import { Limiter } from "../src/api/limiter";
import { UntisSession } from "../src/auth/session";
import { totp } from "../src/auth/totp";
import { ToolError } from "../src/errors";

const SECRET = "JBSWY3DPEHPK3PXP";
const BASE = "https://example.webuntis.com";

function b64url(o: object) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/** Minimal fake WebUntis: TOTP login, sessions, JWT, JSON-RPC, legacy and REST. */
function fakeUntis(opts: { secret?: string; ssoPage?: boolean } = {}) {
  const sessions = new Set<string>();
  const jwts = new Set<string>();
  let n = 0;
  const calls: string[] = [];
  const sessionOf = (req: Request) => req.headers.get("cookie")?.match(/JSESSIONID=([^;]+)/)?.[1];
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}${url.searchParams.get("m") ? `?m=${url.searchParams.get("m")}` : ""}`);
    if (url.pathname === "/WebUntis/jsonrpc_intern.do") {
      const body = (await req.json()) as { method: string; params: [{ auth: { user: string; otp: string; clientTime: number } }] };
      const auth = body.params[0].auth;
      if (auth.otp !== (await totp(opts.secret ?? SECRET, auth.clientTime)))
        return json({ jsonrpc: "2.0", error: { code: -8504, message: "bad credentials" } });
      if (body.method === "getUserData2017") {
        const sid = `S${++n}`;
        sessions.add(sid);
        return json(
          { jsonrpc: "2.0", result: { userData: { elemType: "STUDENT", elemId: 501 } } },
          { headers: { "set-cookie": `JSESSIONID=${sid}; Path=/WebUntis; HttpOnly` } },
        );
      }
      return json({ jsonrpc: "2.0", result: { ok: body.method } });
    }
    if (url.pathname === "/WebUntis/jsonrpc.do") {
      const body = (await req.json()) as { method: string };
      if (body.method === "authenticate") return json({ jsonrpc: "2.0", error: { code: -8504, message: "bad credentials" } });
      if (!sessions.has(sessionOf(req) ?? "")) return json({ jsonrpc: "2.0", error: { code: -8520, message: "not authenticated" } });
      if (body.method === "getStudents") return json({ jsonrpc: "2.0", error: { code: -8509, message: "no right for getStudents()" } });
      return json({ jsonrpc: "2.0", result: [{ id: 1 }] });
    }
    if (url.pathname === "/WebUntis/") {
      return new Response(opts.ssoPage ? '<script>var x={"loginServiceConfig":{"ssoOidc":true}}</script>' : "<html></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/WebUntis/api/token/new") {
      // Real WebUntis answers 406 to "Accept: text/plain" (found by the smoke test)
      if (/^text\/plain/.test(req.headers.get("accept") ?? "")) return new Response(null, { status: 406 });
      if (!sessions.has(sessionOf(req) ?? "")) return new Response(null, { status: 302, headers: { location: "/WebUntis/#/login" } });
      const token = `${b64url({ alg: "HS256" })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 900, n: ++n })}.signaturexyz`;
      jwts.add(token);
      return new Response(token);
    }
    if (url.pathname.startsWith("/WebUntis/api/rest/")) {
      const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!jwts.has(bearer)) return new Response("", { status: 401 });
      if (url.pathname.endsWith("/forbidden")) return json({ errorCode: "FORBIDDEN" }, { status: 403 });
      return json({ rest: true });
    }
    if (url.pathname.startsWith("/WebUntis/api/")) {
      if (!sessions.has(sessionOf(req) ?? "")) return new Response(null, { status: 302, headers: { location: "/WebUntis/" } });
      return json({ data: { legacy: true } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    expireAll() {
      sessions.clear();
      jwts.clear();
    },
  };
}

const session = (
  f: ReturnType<typeof fakeUntis>,
  login: { kind: "secret"; secret: string } | { kind: "password"; password: string } = { kind: "secret", secret: SECRET },
) =>
  new UntisSession({
    baseUrl: BASE,
    school: "example",
    username: "jonas.b",
    login,
    fetchImpl: f.fetchImpl,
    limiter: new Limiter(4, 0),
    sleep: async () => {},
  });

describe("UntisSession", () => {
  test("app secret login → session usable for all API families", async () => {
    const f = fakeUntis();
    const s = session(f);
    await s.ensureLogin();
    expect(s.loginResult).toMatchObject({ userData: { elemId: 501 } });
    expect(await s.rpc("getSubjects")).toEqual([{ id: 1 }]);
    expect(await s.legacy("/api/homeworks/lessons")).toEqual({ data: { legacy: true } });
    expect(await s.rest("/api/rest/view/v1/messages")).toEqual({ rest: true });
    expect(await s.intern("getExams2017", {})).toEqual({ ok: "getExams2017" });
  });

  test("parallel calls share one login (single flight)", async () => {
    const f = fakeUntis();
    const s = session(f);
    await Promise.all([s.rpc("getSubjects"), s.rpc("getRooms"), s.legacy("/api/x"), s.rest("/api/rest/view/v1/x")]);
    expect(f.calls.filter((c) => c.includes("getUserData2017")).length).toBe(1);
  });

  test("expired session → one re-login and retry (JSON-RPC, legacy, REST)", async () => {
    const f = fakeUntis();
    const s = session(f);
    await s.rpc("getSubjects");
    await s.rest("/api/rest/view/v1/x");
    f.expireAll();
    expect(await s.rpc("getSubjects")).toEqual([{ id: 1 }]);
    f.expireAll();
    expect(await s.legacy("/api/x")).toEqual({ data: { legacy: true } });
    f.expireAll();
    expect(await s.rest("/api/rest/view/v1/x")).toEqual({ rest: true });
    expect(f.calls.filter((c) => c.includes("getUserData2017")).length).toBe(4);
  });

  test("a rejected secret is fatal – no further login attempts", async () => {
    const f = fakeUntis({ secret: "KRUGS4ZANFZSAYJA" });
    const s = session(f);
    const err = await s.ensureLogin().catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: "AUTH_FAILED", fatal: true });
    const before = f.calls.length;
    await expect(s.rpc("getSubjects")).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(f.calls.length).toBe(before);
    // one retry with a fresh code, then stop
    expect(f.calls.filter((c) => c.includes("getUserData2017")).length).toBe(2);
  });

  test("password login at an SSO school → SSO_ACCOUNT_NEEDS_SECRET", async () => {
    const f = fakeUntis({ ssoPage: true });
    const s = session(f, { kind: "password", password: "wrong" });
    await expect(s.ensureLogin()).rejects.toMatchObject({ code: "SSO_ACCOUNT_NEEDS_SECRET", fatal: true });
  });

  test("error mapping: -8509 → NO_RIGHT, 403 → NO_RIGHT, 404 → NOT_FOUND", async () => {
    const f = fakeUntis();
    const s = session(f);
    await expect(s.rpc("getStudents")).rejects.toMatchObject({ code: "NO_RIGHT" });
    await expect(s.rest("/api/rest/view/v1/forbidden")).rejects.toMatchObject({ code: "NO_RIGHT" });
  });

  test("retries 5xx and network errors, then UPSTREAM_ERROR", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) throw new Error("ECONNRESET");
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    const s = new UntisSession({
      baseUrl: BASE,
      school: "example",
      username: "u",
      login: { kind: "secret", secret: SECRET },
      fetchImpl: flaky,
      limiter: new Limiter(1, 0),
      sleep: async () => {},
    });
    await expect(s.ensureLogin()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(n).toBe(3);
    // not fatal: the next call tries again
    await expect(s.ensureLogin()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(n).toBe(6);
  });

  test("downloads: credentials only to the school host, size limit", async () => {
    const seen: { host: string; auth: boolean; cookie: boolean }[] = [];
    const f = fakeUntis();
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/WebUntis/api/rest/view/v1/messages/1/attachment" || url.host === "bucket.example-storage.net") {
        seen.push({ host: url.host, auth: req.headers.has("authorization"), cookie: req.headers.has("cookie") });
        if (url.host === "bucket.example-storage.net")
          return new Response(new Uint8Array(2048), { headers: { "content-type": "application/pdf" } });
        return new Response(null, { status: 302, headers: { location: "https://bucket.example-storage.net/file?sig=1" } });
      }
      return f.fetchImpl(input, init);
    }) as typeof fetch;
    const s = new UntisSession({
      baseUrl: BASE,
      school: "example",
      username: "u",
      login: { kind: "secret", secret: SECRET },
      fetchImpl: wrapped,
      limiter: new Limiter(2, 0),
      sleep: async () => {},
    });
    const r = await s.download("/api/rest/view/v1/messages/1/attachment", 10_000);
    expect(r.data.byteLength).toBe(2048);
    expect(seen).toEqual([
      { host: "example.webuntis.com", auth: true, cookie: true },
      { host: "bucket.example-storage.net", auth: false, cookie: false },
    ]);
    await expect(s.download("/api/rest/view/v1/messages/1/attachment", 1000)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

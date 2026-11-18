import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../src/app";
import { startHttpServer } from "../src/http";
import { readyContext } from "./fixtures";

const KEY = "k".repeat(40);
let server: ReturnType<typeof startHttpServer>;
let base: string;

beforeAll(async () => {
  server = startHttpServer(await readyContext(), { host: "127.0.0.1", port: 0, apiKey: KEY, createServer });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function client(key = KEY) {
  const c = new Client({ name: "http-test", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  return c;
}

describe("HTTP transport", () => {
  test("/healthz without auth and without details", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("unknown path → 404", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(404);
  });

  test("missing / wrong API key → 401", async () => {
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    expect((await fetch(`${base}/mcp`, init)).status).toBe(401);
    const wrong = await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${"x".repeat(40)}` } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("browser origin is rejected (DNS rebinding protection)", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Origin: "https://evil.example", Authorization: `Bearer ${KEY}` },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  test("GET/DELETE on /mcp → 405 (stateless mode)", async () => {
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "DELETE", headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(405);
  });

  test("MCP client: list and call tools", async () => {
    const c = await client();
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(12);
    const res = await c.callTool({ name: "untis_list_homework", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { total: number }).total).toBe(2);
    await c.close();
  });

  test("several clients in parallel share the context (registry persists)", async () => {
    const [a, b] = await Promise.all([client(), client()]);
    const [r1, r2] = await Promise.all([
      a.callTool({ name: "untis_list_messages", arguments: {} }),
      b.callTool({ name: "untis_overview", arguments: {} }),
    ]);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    await Promise.all([a.close(), b.close()]);
  });
});

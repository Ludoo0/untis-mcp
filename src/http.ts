/**
 * Streamable HTTP transport (spec 8.1) based on Bun.serve + the SDK's web-standard transport.
 *
 * - POST /mcp  – MCP (stateless, JSON responses); Authorization: Bearer <MCP_API_KEY> required
 * - GET  /healthz – no auth, no details
 * A fresh McpServer per request on top of the shared AppContext (login, caches and person registry persist).
 */
import { timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppContext } from "./context";
import { log } from "./log";

export type HttpOptions = {
  host: string;
  port: number;
  apiKey: string;
  /** Allowed browser origins (empty = requests with an Origin header are rejected → DNS rebinding protection). */
  allowedOrigins?: string[];
  createServer: (ctx: AppContext) => McpServer;
};

const MAX_BODY_BYTES = 1_048_576;

function keyMatches(header: string | null, apiKey: string): boolean {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const given = Buffer.from(m[1]!.trim());
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  json(status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);

export function startHttpServer(ctx: AppContext, opts: HttpOptions) {
  const allowed = new Set(opts.allowedOrigins ?? []);

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req) {
      const url = new URL(req.url);
      const t0 = Date.now();

      if (url.pathname === "/healthz") {
        return req.method === "GET" || req.method === "HEAD" ? json(200, { status: "ok" }) : new Response(null, { status: 405 });
      }
      if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });

      const origin = req.headers.get("origin");
      if (origin && !allowed.has(origin)) {
        log.warn("http: origin rejected");
        return rpcError(403, "Origin not allowed");
      }
      if (!keyMatches(req.headers.get("authorization"), opts.apiKey)) {
        log.warn("http: invalid or missing API key");
        return rpcError(401, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="untis-mcp"' });
      }
      // Stateless mode: no SSE stream (GET) and no sessions (DELETE)
      if (req.method !== "POST") return rpcError(405, "Method not allowed", { Allow: "POST" });

      const mcp = opts.createServer(ctx);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await mcp.connect(transport);
        const res = await transport.handleRequest(req);
        log.debug("http", { status: res.status, ms: Date.now() - t0 });
        return res;
      } catch (e) {
        log.error("http: error while handling the request", { error: e instanceof Error ? e.message : String(e) });
        return rpcError(500, "Internal server error");
      } finally {
        // With enableJsonResponse the response is complete → release server/transport
        queueMicrotask(() => {
          mcp.close().catch(() => {});
        });
      }
    },
  });

  log.info("WebUntis MCP server running", { transport: "http", host: opts.host, port: server.port });
  return server;
}

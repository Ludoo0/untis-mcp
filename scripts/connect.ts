/**
 * Shared setup for scripts against a real instance: config from the environment (.env), app, in-memory MCP client.
 * DATA_DIR defaults to .data (not /data) so the scripts work outside Docker.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, createServer } from "../src/app";
import { ConfigError, loadConfig } from "../src/config";
import { setLogLevel } from "../src/log";

export async function connect() {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig({ DATA_DIR: ".data", ...process.env });
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : String(e));
    process.exit(2);
  }
  setLogLevel((process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "warn");
  const app = createApp(cfg);
  await app.ctx.ensureReady();
  const server = createServer(app.ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "untis-mcp-script", version: "0" });
  await client.connect(ct);
  return {
    ...app,
    client,
    async close() {
      await client.close();
      await app.session.logout();
    },
  };
}

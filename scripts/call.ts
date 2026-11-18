/**
 * Calls one tool against the real instance and prints the (redacted) result.
 *
 *   bun run call                                  → list tools
 *   bun run call untis_get_timetable startDate=2026-11-16
 *   bun run call untis_get_master_data include='["subjects","teachers"]'
 *
 * Values are parsed as JSON when possible (numbers, booleans, arrays), otherwise used as strings.
 */
import { connect } from "./connect";

const [tool, ...pairs] = process.argv.slice(2);
const args: Record<string, unknown> = {};
for (const p of pairs) {
  const i = p.indexOf("=");
  if (i <= 0) {
    console.error(`Invalid argument "${p}" – expected key=value`);
    process.exit(2);
  }
  const raw = p.slice(i + 1);
  try {
    args[p.slice(0, i)] = JSON.parse(raw);
  } catch {
    args[p.slice(0, i)] = raw;
  }
}

const app = await connect();
try {
  if (!tool) {
    const { tools } = await app.client.listTools();
    for (const t of tools) console.log(`${t.name.padEnd(26)} ${t.title ?? ""}`);
  } else {
    const res = await app.client.callTool({ name: tool, arguments: args });
    console.log(JSON.stringify(res.structuredContent ?? res.content, null, 2));
    if (res.isError) process.exitCode = 1;
  }
} finally {
  await app.close();
}

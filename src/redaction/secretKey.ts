/**
 * HMAC secret for stable pseudonyms (spec 6.2): REDACTION_SECRET, or generated once and stored in DATA_DIR/secret.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, registerSecret } from "../log";

export function loadOrCreateSecret(dataDir: string, configured?: string): string {
  if (configured) {
    registerSecret(configured);
    return configured;
  }
  const path = join(dataDir, "secret");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) {
      registerSecret(existing);
      return existing;
    }
  } catch {}
  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, secret, { mode: 0o600 });
  } catch {
    log.warn("Could not persist the pseudonym secret – pseudonyms will change after a restart");
  }
  registerSecret(secret);
  return secret;
}

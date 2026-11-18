/**
 * Teacher directory DATA_DIR/teachers.json (spec 6.2).
 * Created and extended automatically (abbreviation + last name, empty salutation); the user maintains "salutation".
 * No first names and no ids in the file. Changes are picked up without restart. A broken file is never overwritten.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log";

export type TeacherEntry = { abbreviation: string; lastName: string; salutation: string };

const HINT = 'Optional: set "salutation" (e.g. "Frau", "Herr", "Mrs", "Mr") → "Frau Müller". Changes apply without restart.';
const RELOAD_CHECK_MS = 2_000;

const keyOf = (abbreviation: string) => abbreviation.trim().toUpperCase();

export class TeacherDirectory {
  private entries = new Map<string, TeacherEntry>();
  private mtimeMs = 0;
  private lastCheck = 0;
  private fileBroken = false;
  private _version = 0;

  constructor(
    /** null = in-memory only (tests) */
    private path: string | null,
    private now: () => number = Date.now,
  ) {
    this.reload(true);
  }

  get version() {
    this.maybeReload();
    return this._version;
  }

  salutation(abbreviation: string): string {
    this.maybeReload();
    return this.entries.get(keyOf(abbreviation))?.salutation ?? "";
  }

  /** Adds missing teachers (one write for all). */
  ensureAll(list: { abbreviation: string; lastName: string }[]) {
    this.maybeReload();
    let changed = false;
    for (const t of list) {
      const k = keyOf(t.abbreviation);
      if (!k) continue;
      const e = this.entries.get(k);
      if (!e) {
        this.entries.set(k, { abbreviation: t.abbreviation.trim(), lastName: t.lastName.trim(), salutation: "" });
        changed = true;
      } else if (!e.lastName && t.lastName) {
        e.lastName = t.lastName.trim();
        changed = true;
      }
    }
    if (changed) {
      this._version++;
      this.persist();
    }
  }

  private maybeReload() {
    const t = this.now();
    if (t - this.lastCheck < RELOAD_CHECK_MS) return;
    this.lastCheck = t;
    this.reload(false);
  }

  private reload(initial: boolean) {
    if (!this.path) return;
    let mtime: number;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      return;
    }
    if (!initial && mtime === this.mtimeMs) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { teachers?: Partial<Record<keyof TeacherEntry, unknown>>[] };
      const next = new Map<string, TeacherEntry>();
      for (const e of parsed.teachers ?? []) {
        if (!e || typeof e.abbreviation !== "string" || !e.abbreviation.trim()) continue;
        next.set(keyOf(e.abbreviation), {
          abbreviation: e.abbreviation.trim(),
          lastName: String(e.lastName ?? "").trim(),
          salutation: String(e.salutation ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 20),
        });
      }
      for (const [k, e] of this.entries) if (!next.has(k)) next.set(k, e);
      this.entries = next;
      this.mtimeMs = mtime;
      this.fileBroken = false;
      this._version++;
      if (!initial) log.info("teachers.json reloaded", { teachers: next.size });
    } catch {
      if (!this.fileBroken) log.warn("teachers.json is not valid JSON – it will not be overwritten until it is fixed");
      this.fileBroken = true;
      this.mtimeMs = mtime;
    }
  }

  private persist() {
    if (!this.path || this.fileBroken) return;
    const data = {
      _hint: HINT,
      teachers: [...this.entries.values()].sort(
        (a, b) => a.lastName.localeCompare(b.lastName) || a.abbreviation.localeCompare(b.abbreviation),
      ),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
      this.mtimeMs = statSync(this.path).mtimeMs;
    } catch (e) {
      log.warn("Could not write teachers.json", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/**
 * Person registry (spec 6.2): everybody the server has seen in a structured field.
 * Produces the labels for structured output (teacher last names, "Ich", pseudonyms) and the
 * name dictionary for free text. Names live in memory only.
 */
import { createHmac } from "node:crypto";
import { LABELS, type Labels } from "./labels";
import { NameMatcher, type NameParts, SALUTATIONS, spellings, tokenize } from "./names";
import { TeacherDirectory } from "./teachers";

export type Role = "self" | "teacher" | "student" | "parent" | "staff" | "unknown";
export type Person = { display: string; role: Role };
export type ResourceStatus = "regular" | "substitute" | "removed";
export type TeacherDto = { name: string; abbreviation?: string; status?: ResourceStatus };

type TeacherRec = { id?: number; abbreviation: string; firstName: string; lastName: string };
type OtherRec = { role: Exclude<Role, "self" | "teacher">; names: NameParts };

export type RegistryOptions = {
  secret: string;
  /** Instance scope of the pseudonyms (baseUrl|school) */
  scope: string;
  labels?: Labels;
  redactTeachers?: boolean;
  keepAbbreviations?: boolean;
  directory?: TeacherDirectory;
  keepWords?: ReadonlySet<string>;
};

const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class PersonRegistry {
  readonly labels: Labels;
  private secret: string;
  private scope: string;
  private redactTeachers: boolean;
  private keepAbbreviations: boolean;
  private directory: TeacherDirectory;
  private keepWords: ReadonlySet<string>;

  private self?: { studentId?: number; names: NameParts[] };
  private teachersById = new Map<number, TeacherRec>();
  private teachersByAbbr = new Map<string, TeacherRec>();
  private students = new Map<number, NameParts>();
  private others = new Map<string, OtherRec>();
  private codes = new Map<string, string>(); // pseudonym code → key
  private codeCache = new Map<string, string>(); // key → code

  private version = 0;
  private matcherCache?: { version: string; matcher: NameMatcher };

  constructor(opts: RegistryOptions) {
    this.secret = opts.secret;
    this.scope = opts.scope;
    this.labels = opts.labels ?? LABELS.de;
    this.redactTeachers = opts.redactTeachers ?? false;
    this.keepAbbreviations = opts.keepAbbreviations ?? true;
    this.directory = opts.directory ?? new TeacherDirectory(null);
    this.keepWords = opts.keepWords ?? new Set();
  }

  // ---------- Registration ----------

  /** The account owner. Several name sources may be added (login display name, student list, …). */
  setSelf(studentId: number | undefined, names: NameParts) {
    if (!this.self) this.self = { studentId, names: [] };
    if (studentId !== undefined) this.self.studentId = studentId;
    this.self.names.push(names);
    this.version++;
  }

  get selfId() {
    return this.self?.studentId;
  }

  addTeachers(list: { id?: number; abbreviation?: string | null; firstName?: string | null; lastName?: string | null }[]) {
    for (const t of list) {
      const rec: TeacherRec = {
        id: t.id,
        abbreviation: clean(t.abbreviation),
        firstName: clean(t.firstName),
        lastName: clean(t.lastName),
      };
      if (!rec.abbreviation && !rec.lastName) continue;
      const prev =
        (rec.id !== undefined && this.teachersById.get(rec.id)) ||
        (rec.abbreviation && this.teachersByAbbr.get(rec.abbreviation.toUpperCase()));
      const merged = prev
        ? {
            id: prev.id ?? rec.id,
            abbreviation: prev.abbreviation || rec.abbreviation,
            firstName: prev.firstName || rec.firstName,
            lastName: prev.lastName || rec.lastName,
          }
        : rec;
      if (merged.id !== undefined) this.teachersById.set(merged.id, merged);
      if (merged.abbreviation) this.teachersByAbbr.set(merged.abbreviation.toUpperCase(), merged);
    }
    this.directory.ensureAll([...this.teachersByAbbr.values()].map((t) => ({ abbreviation: t.abbreviation, lastName: t.lastName })));
    this.version++;
  }

  addStudents(list: { id: number; firstName?: string | null; lastName?: string | null }[]) {
    for (const s of list) this.students.set(s.id, { firstName: clean(s.firstName), lastName: clean(s.lastName) });
    this.version++;
  }

  /** Other people (message senders, staff). `key` must be stable (e.g. "user:<id>"). */
  addOther(key: string, role: OtherRec["role"], names: NameParts): Person {
    const existing = this.others.get(key);
    if (!existing || JSON.stringify(existing.names) !== JSON.stringify(names)) {
      this.others.set(key, { role, names });
      this.version++;
    }
    return { display: this.pseudonymLabel(role, key), role };
  }

  get studentCount() {
    return this.students.size;
  }

  get teacherCount() {
    return this.teachersByAbbr.size || this.teachersById.size;
  }

  // ---------- Labels ----------

  private code(key: string): string {
    const cached = this.codeCache.get(key);
    if (cached) return cached;
    const hex = createHmac("sha256", this.secret).update(`${this.scope}|${key}`).digest("hex").toUpperCase();
    let code = hex.slice(0, 4);
    if (this.codes.has(code) && this.codes.get(code) !== key) code = hex.slice(0, 6);
    this.codes.set(code, key);
    this.codeCache.set(key, code);
    return code;
  }

  private pseudonymLabel(role: Role, key: string): string {
    const prefix =
      role === "teacher"
        ? this.labels.teacherPrefix
        : role === "student"
          ? this.labels.studentPrefix
          : role === "parent"
            ? this.labels.parentPrefix
            : this.labels.personPrefix;
    return `${prefix}-${this.code(key)}`;
  }

  private teacherKey(t: TeacherRec) {
    return `teacher:${t.abbreviation.toUpperCase() || t.id}`;
  }

  private teacherDisplay(t: TeacherRec): string {
    if (this.redactTeachers) return this.pseudonymLabel("teacher", this.teacherKey(t));
    const last = t.lastName || t.abbreviation;
    const salutation = t.abbreviation ? this.directory.salutation(t.abbreviation) : "";
    return salutation && t.lastName ? `${salutation} ${t.lastName}` : last;
  }

  findTeacher(ref: { id?: number | null; abbreviation?: string | null }): TeacherRec | undefined {
    if (ref.id !== undefined && ref.id !== null) {
      const t = this.teachersById.get(ref.id);
      if (t) return t;
    }
    if (ref.abbreviation) return this.teachersByAbbr.get(clean(ref.abbreviation).toUpperCase());
    return undefined;
  }

  /**
   * Teacher for structured output: last name (+ abbreviation), never the first name.
   * Unknown teachers: the abbreviation, or the given last name run through the name dictionary.
   */
  teacher(ref: { id?: number | null; abbreviation?: string | null; lastName?: string | null; status?: ResourceStatus }): TeacherDto {
    const t = this.findTeacher(ref);
    const status = ref.status && ref.status !== "regular" ? { status: ref.status } : {};
    if (t) {
      const abbr = this.keepAbbreviations && !this.redactTeachers && t.abbreviation ? { abbreviation: t.abbreviation } : {};
      return { name: this.teacherDisplay(t), ...abbr, ...status };
    }
    const abbreviation = clean(ref.abbreviation);
    if (this.redactTeachers) return { name: this.pseudonymLabel("teacher", `teacher:${abbreviation.toUpperCase() || ref.id}`), ...status };
    const lastName = clean(ref.lastName);
    const name = lastName ? this.matcher().apply(lastName) : abbreviation || this.labels.teacherPrefix;
    return { name, ...(this.keepAbbreviations && abbreviation ? { abbreviation } : {}), ...status };
  }

  /** Student by id: the owner becomes "Ich", everybody else a pseudonym. */
  student(id: number): Person {
    if (this.self?.studentId === id) return { display: this.labels.self, role: "self" };
    return { display: this.pseudonymLabel("student", `student:${id}`), role: "student" };
  }

  selfPerson(): Person {
    return { display: this.labels.self, role: "self" };
  }

  teacherPerson(ref: Parameters<PersonRegistry["teacher"]>[0]): Person {
    return { display: this.teacher(ref).name, role: "teacher" };
  }

  /**
   * For the smoke test only: name words that must never appear in tool output
   * (own name, teacher first names, students, other people). Teacher last names are allowed.
   */
  forbiddenWords(): Set<string> {
    const allowed = new Set<string>();
    // Teacher last names are allowed – also the parts of double names ("Meyer-Kranich" → "meyer", "kranich")
    for (const t of new Set([...this.teachersById.values(), ...this.teachersByAbbr.values()]))
      for (const p of tokenize(t.lastName)) for (const part of [p, ...p.split(/['’-]/)]) allowed.add(part);
    const out = new Set<string>();
    const add = (s?: string | null) => {
      for (const p of tokenize(s ?? "")) if (p.length >= 3 && !allowed.has(p)) out.add(p);
    };
    for (const n of this.self?.names ?? []) {
      add(n.firstName);
      add(n.lastName);
      add(n.displayName);
    }
    for (const t of new Set([...this.teachersById.values(), ...this.teachersByAbbr.values()])) add(t.firstName);
    for (const n of this.students.values()) {
      add(n.firstName);
      add(n.lastName);
    }
    for (const o of this.others.values()) add(o.names.displayName);
    return out;
  }

  // ---------- Lookup by display name (message senders) ----------

  private nameIndexCache?: {
    version: number;
    index: Map<string, { kind: "self" } | { kind: "teacher"; t: TeacherRec } | { kind: "student"; id: number } | { kind: "ambiguous" }>;
  };

  private nameIndex() {
    if (this.nameIndexCache?.version === this.version) return this.nameIndexCache.index;
    type V = { kind: "self" } | { kind: "teacher"; t: TeacherRec } | { kind: "student"; id: number } | { kind: "ambiguous" };
    const index = new Map<string, V>();
    const put = (key: string, v: V) => {
      if (!key) return;
      const prev = index.get(key);
      if (!prev) index.set(key, v);
      else if (JSON.stringify(prev) !== JSON.stringify(v)) index.set(key, { kind: "ambiguous" });
    };
    const keys = (n: NameParts, withLastOnly: boolean) => {
      const first = tokenize(n.firstName ?? "").join(" ");
      const last = tokenize(n.lastName ?? "").join(" ");
      const out = [tokenize(n.displayName ?? "").join(" ")];
      if (first && last) out.push(`${first} ${last}`, `${last} ${first}`);
      if (withLastOnly && last) out.push(last);
      return out;
    };
    for (const n of this.self?.names ?? []) for (const k of keys(n, false)) put(k, { kind: "self" });
    for (const t of new Set([...this.teachersById.values(), ...this.teachersByAbbr.values()]))
      for (const k of keys(t, true)) put(k, { kind: "teacher", t });
    for (const [id, n] of this.students) if (id !== this.self?.studentId) for (const k of keys(n, false)) put(k, { kind: "student", id });
    this.nameIndexCache = { version: this.version, index };
    return index;
  }

  /**
   * A person known only by display name (e.g. a message sender): teacher → last name, the owner → "Ich",
   * a student of the school → their pseudonym, anybody else → a stable pseudonym under `key`.
   */
  personByName(displayName: string | null | undefined, key: string, roleHint?: string): Person {
    const tokens = tokenize(displayName ?? "").filter((t) => !SALUTATIONS.includes(t));
    const hit = this.nameIndex().get(tokens.join(" "));
    if (hit?.kind === "self") return this.selfPerson();
    if (hit?.kind === "teacher") return { display: this.teacherDisplay(hit.t), role: "teacher" };
    if (hit?.kind === "student") return this.student(hit.id);
    const hint = (roleHint ?? "").toUpperCase();
    const role: OtherRec["role"] =
      hint === "STUDENT"
        ? "student"
        : hint === "PARENT" || hint === "LEGAL_GUARDIAN"
          ? "parent"
          : /ADMIN|STAFF|DIRECTORATE|TEACHER/.test(hint)
            ? "staff"
            : "unknown";
    return this.addOther(key, role, { displayName });
  }

  // ---------- Name dictionary ----------

  matcher(): NameMatcher {
    const v = `${this.version}|${this.directory.version}`;
    if (this.matcherCache?.version === v) return this.matcherCache.matcher;
    const m = new NameMatcher(this.labels.name, this.keepWords);

    // 1. The owner
    const selfOwner = this.self?.studentId !== undefined ? `student:${this.self.studentId}` : "self";
    for (const names of this.self?.names ?? []) {
      const s = spellings(names);
      for (const p of [...s.multi, ...s.firstParts, ...s.lastParts]) m.add(p, "self", this.labels.self, selfOwner);
    }

    // 2. Teachers: first names never leave the server, last names may stay
    for (const t of new Set([...this.teachersById.values(), ...this.teachersByAbbr.values()])) {
      const owner = this.teacherKey(t);
      const display = this.teacherDisplay(t);
      const { firstParts, lastParts } = spellings(t);
      if (t.firstName && t.lastName) {
        m.add(`${t.lastName} ${t.firstName}`, "replace", display, owner);
        // Combinations with parts of compound names: "Anna Meyer" for "Anna-Lena Meyer-Kranich" → the last name as written
        for (const l of lastParts) {
          const shown = this.redactTeachers ? display : l === t.lastName ? display : l;
          for (const f of firstParts) {
            m.add(`${f} ${l}`, "replace", shown, owner);
            for (const sal of SALUTATIONS)
              m.add(`${sal} ${f} ${l}`, "replace", this.redactTeachers ? display : `${capitalize(sal)} ${l}`, owner);
          }
          m.add(`${t.firstName[0]}. ${l}`, "replace", shown, owner);
        }
      }
      for (const p of lastParts) {
        if (this.redactTeachers) m.add(p, "replace", display, owner);
        else m.add(p, "keep", p, owner);
      }
      for (const p of firstParts) m.add(p, "replace", this.labels.name, owner);
    }

    // 3. Students of the school
    for (const [id, names] of this.students) {
      const owner = `student:${id}`;
      if (owner === selfOwner) continue;
      const label = this.pseudonymLabel("student", owner);
      const s = spellings(names);
      for (const p of [...s.multi, ...s.firstParts, ...s.lastParts]) m.add(p, "replace", label, owner);
    }

    // 4. Other people (message senders, staff)
    for (const [key, rec] of this.others) {
      const label = this.pseudonymLabel(rec.role, key);
      const s = spellings(rec.names);
      for (const p of [...s.multi, ...s.firstParts, ...s.lastParts]) m.add(p, "replace", label, key);
    }

    this.matcherCache = { version: v, matcher: m };
    return m;
  }
}

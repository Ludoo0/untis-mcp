/**
 * WebUntis API probe (developer tool for mapping the API)
 *
 * Logs in (app secret via TOTP or password) and probes the three API families:
 *   - JSON-RPC        /WebUntis/jsonrpc.do            (documented public API)
 *   - JSON-RPC intern /WebUntis/jsonrpc_intern.do     (Untis Mobile app, *2017 methods)
 *   - REST            /WebUntis/api/…                 (legacy web UI) and /WebUntis/api/rest/view/v1/… (current web app)
 * for a window of ±14 days around today.
 *
 * Result: probe-output/report.json – REDACTED, i.e. structure only:
 *   field names + types, counts, HTTP status, JSON-RPC error codes, URL patterns
 *   and values of a few enum fields (status, type, cellState …). No names, no texts, no ids.
 *
 * Only reading requests are sent. The few POST calls are list queries of the web app
 * (homework list, absences list) – they do not change anything.
 *
 * Run:   bun run probe           (redacted report only)
 *        bun run probe --save    (additionally raw data to probe-output/raw/ – private!)
 *        bun run probe --help
 */

import { addDays, decodeJwtPayload, isoDate, loadCredentials, type RpcResult, UntisSession, untisDate } from "../lib";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: bun run probe [--save]

Credentials come from UNTIS_QR_URL, or UNTIS_BASE_URL + UNTIS_SCHOOL + UNTIS_USERNAME + UNTIS_APP_SECRET
(or UNTIS_PASSWORD), or are asked for interactively.

Writes a structure-only report to probe-output/report.json (safe to share).
--save additionally stores raw responses in probe-output/raw/ (private, never share or commit).`);
  process.exit(0);
}

const SAVE = process.argv.includes("--save");
const OUT = "probe-output";
const RAW = `${OUT}/raw`;
const DELAY_MS = 300;
const WINDOW_DAYS = 14;

type Json = any;

// =====================================================================
// Redaction
// =====================================================================

/** Fields whose values are harmless categories and may stay in the report. */
const ENUM_FIELDS = new Set([
  "type",
  "status",
  "statusDetail",
  "state",
  "cellState",
  "code",
  "lstype",
  "activityType",
  "elemType",
  "personType",
  "roleType",
  "role",
  "roles",
  "userRole",
  "layout",
  "timetableType",
  "resourceType",
  "periodType",
  "is",
  "can",
  "icons",
  "excuseStatus",
  "isExcused",
  "deviceOs",
  "examType",
  "dayStatus",
  "kind",
  "contentType",
  "rights",
]);

/** Field names that refer directly to people. */
const PERSON_RE =
  /(foreName|firstName|lastName|longName|displayName|displayname|fullName|^name$|^sn$|^fn$|personId|studentId|teacherId|userId|person|student|teacher|parent|guardian|sender|recipient|creator|createdUser|updatedUser|author|email|mail|phone|avatar|image|children|klasse)/i;
/** Field names with free text that may contain names etc. */
const FREETEXT_RE = /(text|body|content|subject|remark|info|note|title|message|reason|comment|description|preview)/i;

type Ctx = { enums: Map<string, Set<string>>; urls: Map<string, Set<string>> };
const newCtx = (): Ctx => ({ enums: new Map(), urls: new Map() });

function addTo(map: Map<string, Set<string>>, key: string, value: string, limit = 20) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  if (set.size < limit) set.add(value);
}

function redactSegment(seg: string): string {
  if (!seg) return seg;
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {}
  if (/^\d+$/.test(s)) return "{n}";
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return "{guid}";
  if (/^v\d{1,2}$/i.test(s)) return s; // API versions (v1, v2 …)
  if (/^[\w-]+\.(do|html?|js|json)$/i.test(s)) return s;
  const ext = s.match(/\.([a-z0-9]{1,5})$/i);
  if (ext) return `{file}.${ext[1]!.toLowerCase()}`;
  if (s.length > 24 || /[^\w.-]/.test(s) || (/\d/.test(s) && /[a-z]/i.test(s))) return "{token}";
  return s;
}

/** Keeps host + path structure of WebUntis URLs, replaces ids/tokens and all query values.
 *  The school's own host is replaced by <school>. External URLs are replaced entirely. */
function redactUrl(raw: string, base: string): string {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return "{unparseable}";
  }
  if (u.protocol === "data:") return "data:{…}";
  const own = new URL(base).host;
  let host: string;
  if (u.host === own) host = "<school>.webuntis.com";
  else if (/(^|\.)(webuntis\.com|untis\.(at|com|de)|untis-cloud\.\w+)$/i.test(u.hostname)) host = u.host;
  else if (/(amazonaws\.com|blob\.core\.windows\.net|googleapis\.com)$/i.test(u.hostname))
    host = `{storage:${u.hostname.split(".").slice(-2).join(".")}}`;
  else return "{external-url}";
  const path = u.pathname.split("/").map(redactSegment).join("/");
  const keys = [...new Set(u.searchParams.keys())];
  const qs = keys.length ? `?${keys.map((k) => `${k}={${/^\d+$/.test(u.searchParams.get(k) ?? "") ? "n" : "v"}}`).join("&")}` : "";
  return `${u.protocol}//${host}${path}${qs}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function mergeSchemas(a: Json, b: Json): Json {
  if (a === undefined || a === "null") return b;
  if (b === undefined || b === "null") return a;
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, Json> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = mergeSchemas(out[k], v);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length ? (b.length ? [mergeSchemas(a[0], b[0])] : a) : b;
  return a;
}

/** Map-like objects keyed by ids (e.g. elementPeriods: { "123": [...] }) – keys are ids, not field names. */
const isIdKeyed = (o: Record<string, unknown>) => {
  const keys = Object.keys(o);
  return keys.length > 0 && keys.every((k) => /^-?\d+$/.test(k));
};

function schemaOf(v: unknown, ctx: Ctx, base: string, key = "", depth = 0): Json {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    if (ENUM_FIELDS.has(key) && v.every((x) => typeof x === "string")) {
      for (const x of v) if (x.length <= 40 && !x.includes("@")) addTo(ctx.enums, key, x);
      return ["string"];
    }
    let merged: Json;
    for (const item of v.slice(0, 25)) merged = mergeSchemas(merged, schemaOf(item, ctx, base, key, depth + 1));
    return [merged];
  }
  if (typeof v === "object") {
    if (depth > 10) return "object(…)";
    const o = v as Record<string, unknown>;
    if (isIdKeyed(o)) {
      let merged: Json;
      for (const val of Object.values(o).slice(0, 25)) merged = mergeSchemas(merged, schemaOf(val, ctx, base, key, depth + 1));
      return { "{id}": merged };
    }
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(o)) out[k] = schemaOf(val, ctx, base, k, depth + 1);
    return out;
  }
  if (typeof v === "string") {
    if (ENUM_FIELDS.has(key) && v.length <= 40 && !v.includes("@") && !/\s{2,}/.test(v)) addTo(ctx.enums, key, v);
    if (/^https?:\/\//i.test(v) || /^\/WebUntis\//.test(v)) {
      if (!FREETEXT_RE.test(key) || /url$/i.test(key)) addTo(ctx.urls, key, redactUrl(v, base), 8);
      return "url";
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return "datetime";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
    if (/^[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}$/.test(v)) return "jwt";
    if (/<[a-z][^>]*>/i.test(v)) return "html";
    return v.length ? "string" : "string(empty)";
  }
  if (typeof v === "number") {
    if (ENUM_FIELDS.has(key)) addTo(ctx.enums, key, String(v));
    if (/date$/i.test(key) && v > 19000000 && v < 21000000) return "number(yyyymmdd)";
    if (/time$/i.test(key) && v >= 0 && v <= 2400) return "number(hhmm)";
    return "number";
  }
  if (typeof v === "boolean" && ENUM_FIELDS.has(key)) addTo(ctx.enums, key, String(v));
  return typeof v;
}

function sensitivePaths(schema: Json): { person: string[]; freetext: string[] } {
  const res = { person: [] as string[], freetext: [] as string[] };
  const walk = (s: Json, p: string): void => {
    if (Array.isArray(s)) {
      if (s[0] !== undefined) walk(s[0], `${p}[]`);
      return;
    }
    if (!isPlainObject(s)) return;
    for (const [k, v] of Object.entries(s)) {
      const path = p ? `${p}.${k}` : k;
      if (PERSON_RE.test(k)) res.person.push(path);
      else if (FREETEXT_RE.test(k) && (v === "string" || v === "html")) res.freetext.push(path);
      walk(v, path);
    }
  };
  walk(schema, "");
  return res;
}

const toRecord = (m: Map<string, Set<string>>) => (m.size ? Object.fromEntries([...m].map(([k, s]) => [k, [...s]])) : undefined);

function sanitizeError(text: string, base: string): string {
  if (/<html|<!DOCTYPE/i.test(text)) return "HTML page";
  return text
    .replace(/https?:\/\/[^\s'"]+/gi, (u) => redactUrl(u, base))
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "{email}")
    .replace(/\d+/g, "{n}")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

const slug = (s: string) =>
  s
    .replace(/[^\w-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 70);

/** Counts the main list in a response (first array found within two levels). */
function countOf(j: Json): number | undefined {
  if (Array.isArray(j)) return j.length;
  if (!isPlainObject(j)) return undefined;
  for (const v of Object.values(j)) if (Array.isArray(v)) return v.length;
  for (const v of Object.values(j)) if (isPlainObject(v)) for (const w of Object.values(v)) if (Array.isArray(w)) return w.length;
  return undefined;
}

/** Recursively finds the first array under a key matching `re`. */
function findArray(j: Json, re: RegExp, depth = 0): Json[] | undefined {
  if (depth > 6 || !j || typeof j !== "object") return undefined;
  if (Array.isArray(j)) {
    for (const x of j) {
      const r = findArray(x, re, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(j)) if (re.test(k) && Array.isArray(v)) return v;
  for (const v of Object.values(j)) {
    const r = findArray(v, re, depth + 1);
    if (r) return r;
  }
  return undefined;
}

// =====================================================================
// Report
// =====================================================================

type StepResult = {
  step: string;
  endpoint: string;
  status: number | string;
  rpcError?: number;
  ms?: number;
  count?: number;
  error?: string;
  schema?: Json;
  enums?: Record<string, string[]>;
  urlPatterns?: Record<string, string[]>;
  sensitive?: { person: string[]; freetext: string[] };
  [extra: string]: unknown;
};

const steps: StepResult[] = [];
const findings: string[] = [];

function logStep(r: StepResult) {
  const ok = typeof r.status === "number" && r.status >= 200 && r.status < 300 && r.rpcError === undefined;
  const n = r.count !== undefined ? ` · ${r.count} entries` : "";
  const code = r.rpcError !== undefined ? ` (rpc ${r.rpcError})` : "";
  console.log(`${ok ? "✅" : "❌"} ${String(r.status).padEnd(4)} ${r.step}${n}${code}`);
  console.log(`         ${r.endpoint}${r.error ? `\n         → ${r.error}` : ""}`);
}

let s!: UntisSession;

async function analyse(r: StepResult, json: Json) {
  const ctx = newCtx();
  r.schema = schemaOf(json, ctx, s.base);
  r.count = countOf(json);
  r.enums = toRecord(ctx.enums);
  r.urlPatterns = toRecord(ctx.urls);
  const sens = sensitivePaths(r.schema);
  if (sens.person.length || sens.freetext.length) r.sensitive = sens;
  if (SAVE) await Bun.write(`${RAW}/${slug(r.step)}.json`, JSON.stringify(json, null, 2));
}

async function finish(r: StepResult) {
  steps.push(r);
  logStep(r);
  await Bun.sleep(DELAY_MS);
}

/** REST call (GET or read-only POST query) with schema analysis. */
async function rest(
  step: string,
  path: string,
  opts: { method?: string; body?: unknown; bearer?: boolean } = {},
): Promise<Json | undefined> {
  const r: StepResult = {
    step,
    endpoint: `${opts.method ?? "GET"} ${redactUrl(path, s.base).replace(/^https:\/\/<school>\.webuntis\.com/, "")}`,
    status: "?",
  };
  if (opts.body !== undefined) r.requestBodyKeys = Object.keys(opts.body as object);
  const t0 = performance.now();
  let json: Json;
  try {
    const res = await s.request(path, opts);
    const text = await res.text();
    r.status = res.status;
    r.ms = Math.round(performance.now() - t0);
    r.contentType = res.headers.get("content-type")?.split(";")[0] ?? null;
    if (res.status >= 300 && res.status < 400) r.redirect = redactUrl(res.headers.get("location") ?? "", s.base);
    try {
      json = JSON.parse(text);
    } catch {}
    if (res.ok && json !== undefined) await analyse(r, json);
    else if (!res.ok) r.error = sanitizeError(text, s.base);
    else r.error = `not JSON (${text.length} bytes)`;
  } catch (e) {
    r.status = "network-error";
    r.error = e instanceof Error ? e.message : String(e);
  }
  await finish(r);
  return typeof r.status === "number" && r.status < 300 ? json : undefined;
}

/** JSON-RPC call with schema analysis. */
async function rpc(step: string, kind: "rpc" | "intern", method: string, params: Json = {}): Promise<Json | undefined> {
  const r: StepResult = {
    step,
    endpoint: kind === "rpc" ? `jsonrpc.do ${method}` : `jsonrpc_intern.do ${method}`,
    status: "?",
    paramKeys: isPlainObject(params) ? Object.keys(params) : undefined,
  };
  const t0 = performance.now();
  let res: RpcResult;
  try {
    res = kind === "rpc" ? await s.rpc(method, params) : await s.rpcIntern(method, params);
  } catch (e) {
    r.status = "network-error";
    r.error = e instanceof Error ? e.message : String(e);
    await finish(r);
    return undefined;
  }
  r.status = res.status;
  r.ms = Math.round(performance.now() - t0);
  if (res.ok) await analyse(r, res.result);
  else {
    r.rpcError = res.code;
    r.error = sanitizeError(res.message, s.base);
  }
  await finish(r);
  return res.ok ? res.result : undefined;
}

/** Probes a file URL/endpoint: status, type, size – the content is only stored with --save. */
async function probeFile(step: string, path: string, bearer = true) {
  const r: StepResult = { step, endpoint: redactUrl(path, s.base), status: "?" };
  try {
    const res =
      path.startsWith("http") && !path.startsWith(s.base) ? await fetch(path, { redirect: "manual" }) : await s.request(path, { bearer });
    const buf = await res.arrayBuffer();
    r.status = res.status;
    r.contentType = res.headers.get("content-type")?.split(";")[0] ?? null;
    r.contentDisposition = res.headers.get("content-disposition")?.split(";")[0] ?? null;
    r.bytes = buf.byteLength;
    if (res.status >= 300 && res.status < 400) r.redirect = redactUrl(res.headers.get("location") ?? "", s.base);
    if (r.contentType === "application/json" || r.contentType === "text/plain") {
      try {
        const json = JSON.parse(new TextDecoder().decode(buf));
        await analyse(r, json);
      } catch {}
    }
    if (SAVE && res.ok) await Bun.write(`${RAW}/${slug(step)}.bin`, buf);
  } catch (e) {
    r.status = "network-error";
    r.error = e instanceof Error ? e.message : String(e);
  }
  await finish(r);
}

// =====================================================================
// Probe
// =====================================================================

async function main() {
  const creds = await loadCredentials();
  s = new UntisSession(creds);
  const today = new Date();
  const from = addDays(today, -WINDOW_DAYS);
  const to = addDays(today, WINDOW_DAYS);
  const weekFrom = addDays(today, -((today.getDay() + 6) % 7)); // Monday
  const weekTo = addDays(weekFrom, 6);
  console.log(`Probing ${redactUrl(creds.baseUrl, creds.baseUrl)} with ${creds.kind} login, window ${isoDate(from)} … ${isoDate(to)}\n`);

  // ---------- Public (no login) ----------
  await rest("public: messages of the day", `/WebUntis/api/public/news/newsWidgetData?date=${untisDate(today)}`, { bearer: false });

  // ---------- Login ----------
  const t0 = performance.now();
  const login: RpcResult = await s.login().catch((e: unknown) => ({
    ok: false as const,
    status: 0,
    message: `network error: ${e instanceof Error ? e.message : String(e)}`,
  }));
  const loginStep: StepResult = {
    step: `login (${creds.kind === "secret" ? "jsonrpc_intern getUserData2017 + TOTP" : "jsonrpc authenticate"})`,
    endpoint: creds.kind === "secret" ? "jsonrpc_intern.do getUserData2017" : "jsonrpc.do authenticate",
    status: login.status,
    ms: Math.round(performance.now() - t0),
    cookiesAfterLogin: s.jar.names(),
  };
  if (login.ok) {
    await analyse(loginStep, login.result);
  } else {
    loginStep.rpcError = login.code;
    loginStep.error = sanitizeError(login.message, s.base);
  }
  await finish(loginStep);
  if (!login.ok) {
    findings.push("Login failed – remaining steps skipped.");
    return;
  }

  // Own element (student) from the login result
  const lr = s.loginResult ?? {};
  let elemType: string | number | undefined = lr.userData?.elemType ?? lr.personType;
  let elemId: number | undefined = lr.userData?.elemId ?? lr.personId;
  const klasseId: number | undefined = lr.klasseId ?? lr.userData?.klassenIds?.[0];
  findings.push(`Login result: elemType=${String(elemType)}, has elemId=${elemId !== undefined}, has klasseId=${klasseId !== undefined}`);

  // ---------- Session info / JWT ----------
  const dtc = await rest("legacy: daytimetable config (session info)", "/WebUntis/api/daytimetable/config", { bearer: false });
  const appCfg = await rest("legacy: app config", "/WebUntis/api/app/config", { bearer: false });
  if (elemId === undefined) {
    elemId = dtc?.data?.personId ?? appCfg?.data?.loginServiceConfig?.user?.personId;
    elemType = dtc?.data?.personType ?? elemType;
  }
  const jwt = await s.fetchJwt();
  const claims = jwt.token ? decodeJwtPayload(jwt.token) : undefined;
  const jwtStep: StepResult = { step: "token/new (JWT for REST)", endpoint: "GET /WebUntis/api/token/new", status: jwt.status };
  if (claims) {
    jwtStep.claimNames = Object.keys(claims);
    if (typeof claims.exp === "number" && typeof claims.iat === "number") jwtStep.lifetimeSeconds = claims.exp - claims.iat;
  } else jwtStep.error = "no JWT returned";
  await finish(jwtStep);

  const typeNum = typeof elemType === "number" ? elemType : elemType === "STUDENT" ? 5 : elemType === "TEACHER" ? 2 : 5;
  const typeName = typeof elemType === "string" ? elemType : typeNum === 5 ? "STUDENT" : typeNum === 12 ? "PARENT" : "STUDENT";
  findings.push(`Own element type used for queries: ${typeName} (${typeNum})`);

  // ---------- JSON-RPC (documented API) ----------
  const schoolyear = await rpc("rpc: current school year", "rpc", "getCurrentSchoolyear");
  await rpc("rpc: school years", "rpc", "getSchoolyears");
  await rpc("rpc: latest import time", "rpc", "getLatestImportTime");
  await rpc("rpc: subjects", "rpc", "getSubjects");
  await rpc("rpc: rooms", "rpc", "getRooms");
  await rpc("rpc: classes", "rpc", "getKlassen", schoolyear?.id ? { schoolyearId: schoolyear.id } : {});
  await rpc("rpc: teachers", "rpc", "getTeachers");
  await rpc("rpc: students", "rpc", "getStudents");
  await rpc("rpc: holidays", "rpc", "getHolidays");
  await rpc("rpc: timegrid", "rpc", "getTimegridUnits");
  await rpc("rpc: status data (colors)", "rpc", "getStatusData");
  if (elemId !== undefined) {
    await rpc("rpc: timetable (own, extended fields)", "rpc", "getTimetable", {
      options: {
        element: { id: elemId, type: typeNum },
        startDate: untisDate(weekFrom),
        endDate: untisDate(addDays(weekTo, 7)),
        showInfo: true,
        showSubstText: true,
        showLsText: true,
        showLsNumber: true,
        showStudentgroup: true,
        klasseFields: ["id", "name", "longname"],
        teacherFields: ["id", "name", "longname"],
        subjectFields: ["id", "name", "longname"],
        roomFields: ["id", "name", "longname"],
      },
    });
  }
  await rpc("rpc: substitutions", "rpc", "getSubstitutions", {
    startDate: untisDate(today),
    endDate: untisDate(addDays(today, 7)),
    departmentId: 0,
  });
  await rpc("rpc: exam types", "rpc", "getExamTypes");
  await rpc("rpc: exams", "rpc", "getExams", { startDate: untisDate(from), endDate: untisDate(to), examTypeId: 0 });
  await rpc("rpc: class register events", "rpc", "getClassregEvents", { startDate: untisDate(from), endDate: untisDate(to) });
  await rpc("rpc: timetable with absences", "rpc", "getTimetableWithAbsences", {
    options: { startDate: untisDate(from), endDate: untisDate(today) },
  });

  // ---------- JSON-RPC intern (mobile app, secret only) ----------
  if (creds.kind === "secret" && elemId !== undefined) {
    const range = { startDate: isoDate(from), endDate: isoDate(to) };
    await rpc("intern: timetable 2017", "intern", "getTimetable2017", {
      id: elemId,
      type: typeName,
      startDate: isoDate(weekFrom),
      endDate: isoDate(weekTo),
      masterDataTimestamp: 0,
      timetableTimestamp: 0,
      timetableTimestamps: [],
    });
    await rpc("intern: homework 2017", "intern", "getHomeWork2017", { id: elemId, type: typeName, ...range });
    await rpc("intern: exams 2017", "intern", "getExams2017", { id: elemId, type: typeName, ...range });
    await rpc("intern: student absences 2017", "intern", "getStudentAbsences2017", {
      ...range,
      includeExcused: true,
      includeUnExcused: true,
    });
    await rpc("intern: messages of the day 2017", "intern", "getMessagesOfDay2017", { date: isoDate(today) });
  }

  // ---------- Legacy REST (old web UI, session cookie) ----------
  if (elemId !== undefined) {
    const pc = await rest("legacy: weekly timetable page config", `/WebUntis/api/public/timetable/weekly/pageconfig?type=${typeNum}`, {
      bearer: false,
    });
    const formatId = pc?.data?.selectedFormatId ?? pc?.data?.formatId ?? 1;
    await rest(
      "legacy: weekly timetable data",
      `/WebUntis/api/public/timetable/weekly/data?elementType=${typeNum}&elementId=${elemId}&date=${isoDate(today)}&formatId=${formatId}`,
      { bearer: false },
    );
  }
  const hwLegacy = await rest(
    "legacy: homeworks/lessons",
    `/WebUntis/api/homeworks/lessons?startDate=${untisDate(from)}&endDate=${untisDate(to)}`,
    { bearer: false },
  );
  await rest(
    "legacy: exams",
    `/WebUntis/api/exams?startDate=${untisDate(from)}&endDate=${untisDate(to)}&klasseId=${klasseId ?? -1}&withGrades=true`,
    {
      bearer: false,
    },
  );
  if (elemId !== undefined) {
    await rest(
      "legacy: student absences",
      `/WebUntis/api/classreg/absences/students?startDate=${untisDate(addDays(today, -120))}&endDate=${untisDate(today)}&studentId=${elemId}&excuseStatusId=-1`,
      { bearer: false },
    );
  }
  await rest("legacy: messages of the day (authenticated)", `/WebUntis/api/public/news/newsWidgetData?date=${untisDate(today)}`, {
    bearer: false,
  });

  // Homework attachments (legacy)
  const hwWithFile = (hwLegacy?.data?.homeworks ?? []).find((h: Json) => Array.isArray(h?.attachments) && h.attachments.length);
  if (hwWithFile) {
    const att = hwWithFile.attachments[0];
    findings.push(`Homework attachment fields: ${Object.keys(att).join(", ")}`);
    if (typeof att.url === "string") await probeFile("legacy: homework attachment download", att.url, false);
    else if (att.id !== undefined)
      await probeFile("legacy: homework attachment download (by id)", `/WebUntis/api/homeworks/attachments/${att.id}`, false);
  } else findings.push("No homework attachment found in the window.");

  // ---------- REST view v1 (current web app, bearer) ----------
  await rest("rest: app data", "/WebUntis/api/rest/view/v1/app/data");
  await rest("rest: today meta", "/WebUntis/api/rest/view/v1/today/meta");
  await rest("rest: school years", "/WebUntis/api/rest/view/v1/schoolyears");
  await rest("rest: timegrid", "/WebUntis/api/rest/view/v1/timegrid");
  await rest("rest: dashboard cards", "/WebUntis/api/rest/view/v1/dashboard/cards");
  await rest("rest: timetable menu", "/WebUntis/api/rest/view/v1/timetable/menu");
  const filter = await rest(
    "rest: timetable filter (my timetable)",
    "/WebUntis/api/rest/view/v1/timetable/filter?resourceType=STUDENT&timetableType=MY_TIMETABLE",
  );
  const resourceId = filter?.preSelected?.id ?? filter?.resources?.[0]?.id ?? elemId;
  const entries = await rest(
    "rest: timetable entries (my timetable, 2 weeks)",
    `/WebUntis/api/rest/view/v1/timetable/entries?start=${isoDate(weekFrom)}&end=${isoDate(addDays(weekTo, 7))}&format=1&resourceType=STUDENT&resources=${resourceId ?? ""}&timetableType=MY_TIMETABLE&layout=START_TIME`,
  );
  if (entries) {
    const days = findArray(entries, /^days$/) ?? [];
    const grid = days.flatMap((d: Json) => (Array.isArray(d?.gridEntries) ? d.gridEntries : []));
    findings.push(`timetable/entries: ${days.length} days, ${grid.length} grid entries`);
    const first = grid.find((g: Json) => g?.duration?.start && g?.duration?.end);
    const firstId = first?.ids?.[0];
    if (first && firstId !== undefined) {
      await rest(
        "rest: calendar entry detail (first entry)",
        `/WebUntis/api/rest/view/v2/calendar-entry/detail?elementId=${resourceId ?? ""}&elementType=${typeNum}&startDateTime=${encodeURIComponent(first.duration.start)}&endDateTime=${encodeURIComponent(first.duration.end)}&homeworkOption=DUE`,
      );
    }
  }
  await rest("rest: period day states", `/WebUntis/api/v2/periods/day-states?date_from=${isoDate(from)}&date_to=${isoDate(to)}`);

  // Homework list (read-only POST query of the web app)
  await rest("rest: homework list meta", "/WebUntis/api/rest/view/v1/classreg/homework/meta");
  await rest("rest: homework list (POST query)", "/WebUntis/api/rest/view/v1/classreg/homework/list", {
    method: "POST",
    body: { startDate: isoDate(from), endDate: isoDate(to) },
  });

  // Absences (read-only POST queries)
  await rest("rest: absences meta", "/WebUntis/api/rest/view/v1/classreg/absences/meta");
  for (const v of ["v1", "v3", "v4"]) {
    await rest(`rest: absences ${v} (POST query)`, `/WebUntis/api/rest/view/${v}/classreg/absences`, {
      method: "POST",
      body: { startDate: isoDate(addDays(today, -120)), endDate: isoDate(today), studentId: elemId },
    });
  }

  // Exams
  await rest("rest: exams (GET with range)", `/WebUntis/api/rest/view/v1/exams?start=${isoDate(from)}&end=${isoDate(to)}`);

  // Messages
  await rest("rest: message center status", "/WebUntis/api/rest/view/v1/messages/status");
  await rest("rest: message permissions", "/WebUntis/api/rest/view/v1/messages/permissions");
  const inbox = await rest("rest: incoming messages", "/WebUntis/api/rest/view/v1/messages");
  const msgs: Json[] = inbox?.incomingMessages ?? findArray(inbox, /messages/i) ?? [];
  findings.push(`Inbox: ${msgs.length} messages, ${msgs.filter((m) => m?.hasAttachments).length} with attachments`);
  const firstMsg = msgs[0];
  if (firstMsg?.id !== undefined) {
    await rest("rest: message detail (first)", `/WebUntis/api/rest/view/v1/messages/${firstMsg.id}?contentAsHtml=true`);
  }
  const withAtt = msgs.find((m) => m?.hasAttachments);
  if (withAtt?.id !== undefined) {
    const detail = await rest(
      "rest: message detail (with attachment)",
      `/WebUntis/api/rest/view/v1/messages/${withAtt.id}?contentAsHtml=true`,
    );
    const atts: Json[] = detail?.storageAttachments ?? detail?.attachments ?? findArray(detail, /attachment/i) ?? [];
    if (atts[0]) findings.push(`Message attachment fields: ${Object.keys(atts[0]).join(", ")}`);
    const key = atts[0]?.id ?? atts[0]?.storageClientKey;
    if (key !== undefined) {
      const urlRes = await rest(
        "rest: attachment storage url",
        `/WebUntis/api/rest/view/v1/messages/${encodeURIComponent(String(key))}/attachmentstorageurl`,
      );
      const signed = urlRes?.downloadUrl ?? urlRes?.url;
      if (typeof signed === "string") await probeFile("attachment download via storage url", signed);
    }
    if (detail?.blobAttachment?.id !== undefined || detail?.blobAttachment) {
      await probeFile("rest: blob attachment download", `/WebUntis/api/rest/view/v1/messages/${withAtt.id}/attachment`);
    }
  } else findings.push("No message with attachment found.");
  await rest("rest: read-confirmation messages (sent)", "/WebUntis/api/rest/view/v1/messages/sent");
}

try {
  await main();
} finally {
  if (s as UntisSession | undefined) await s.logout();
  const report = {
    generatedAt: new Date().toISOString(),
    note: "Structure only – field names, types, counts, status codes, enum values, URL patterns. No content.",
    findings,
    steps,
  };
  await Bun.write(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\nRedacted report: ${OUT}/report.json  (contains no content – safe to share)`);
  if (SAVE) console.log(`Raw data: ${RAW}/  (PRIVATE – never share or commit)`);
}

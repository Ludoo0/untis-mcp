/**
 * Smoke and leak test against the real account (spec 10): calls every tool once and checks every output
 * against the real names the server knows (own name, students, teacher first names, other people) and
 * against secret patterns. Teacher last names are allowed.
 *
 * The output contains only tool names, counts and MASKED findings (letters → x, digits → 9) – safe to share.
 *
 *   bun run smoke            summary
 *   bun run smoke --details  plus masked context of every finding
 *   bun run smoke --messages also opens the newest message (WebUntis may mark it as read!)
 *
 * Exit code 1 on findings or tool errors.
 */
import { addDays, mondayOf } from "../src/dates";
import { STOPWORDS, tokenize } from "../src/redaction/names";
import { connect } from "./connect";

const DETAILS = process.argv.includes("--details");
const OPEN_MESSAGE = process.argv.includes("--messages");
const mask = (s: string) => s.replace(/\p{L}/gu, "x").replace(/\d/g, "9");

const SECRET_PATTERNS: [string, RegExp][] = [
  ["webuntis-url", /https?:\/\/[^\s"]*webuntis\.com/i],
  ["storage-url", /amazonaws\.com|blob\.core\.windows\.net|X-Amz-|[?&]sig=/i],
  ["jwt", /\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/],
  ["jsessionid", /JSESSIONID/i],
  ["untis-qr", /untis:\/\//i],
  ["id-field", /"(personId|studentId|userId|elemId|person_id)"/i],
  ["email", /[\w.+-]+@[\w-]+\.[\w.]+/],
];

const app = await connect();
const forbidden = [...app.ctx.redactor.people.forbiddenWords()].filter((w) => !STOPWORDS.has(w));
const today = app.ctx.today();
let problems = 0;

// Not leaks: teacher abbreviations written in capitals ("BEN") and school vocabulary (subject, room and class names)
// that happen to equal a student name – reported as notes, not as findings.
const master = app.ctx.master();
const abbreviations = new Set(master.teachers.map((t) => (t.name ?? "").trim()).filter(Boolean));
const vocabulary = new Set(
  [...master.subjects.values(), ...master.rooms.values(), ...master.classes.values()].flatMap((n) =>
    tokenize(`${n.short} ${n.name ?? ""}`),
  ),
);

type Call = [string, Record<string, unknown>];
const calls: Call[] = [
  ["untis_overview", {}],
  ["untis_get_timetable", { startDate: mondayOf(today), endDate: addDays(mondayOf(today), 13) }],
  ["untis_list_changes", { days: 14 }],
  ["untis_list_homework", { startDate: addDays(today, -21), endDate: addDays(today, 9) }],
  ["untis_list_exams", { startDate: addDays(today, -30), endDate: addDays(today, 60) }],
  ["untis_list_absences", {}],
  ["untis_list_messages", { limit: 100 }],
  ["untis_messages_of_day", {}],
  ["untis_get_master_data", { include: ["subjects", "teachers", "rooms", "classes", "timegrid", "holidays", "schoolyears"] }],
];

console.log(`Name dictionary: ${forbidden.length} words to check · ${app.ctx.redactor.people.teacherCount} teachers\n`);

async function check(name: string, args: Record<string, unknown>) {
  const res = await app.client.callTool({ name, arguments: args });
  const out = JSON.stringify(res);
  const findings: string[] = [];
  const notes = { abbreviation: 0, vocabulary: 0 };
  const lower = out.toLowerCase();
  for (const w of forbidden) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    if (!lower.includes(w)) continue;
    for (const m of out.matchAll(re)) {
      const i = m.index ?? 0;
      if (abbreviations.has(m[0]) && m[0] === m[0].toUpperCase()) {
        notes.abbreviation++;
        continue;
      }
      if (vocabulary.has(w)) {
        notes.vocabulary++;
        continue;
      }
      findings.push(`name ${mask(m[0])}${DETAILS ? `  …${mask(out.slice(Math.max(0, i - 40), i + 40))}…` : ""}`);
    }
  }
  for (const [label, re] of SECRET_PATTERNS) {
    const m = out.match(re);
    if (m) findings.push(`${label}${DETAILS ? `  …${mask(out.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 40))}…` : ""}`);
  }
  const sc = res.structuredContent as Record<string, unknown> | undefined;
  const counts = sc
    ? Object.entries(sc)
        .filter(([, v]) => Array.isArray(v) || typeof v === "number")
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v}`)
        .join(" ")
    : "";
  const err = res.isError ? ` ERROR ${(sc?.error as { code?: string } | undefined)?.code ?? "?"}` : "";
  const noteText =
    notes.abbreviation || notes.vocabulary
      ? `  (notes: ${notes.abbreviation} teacher abbreviations, ${notes.vocabulary} subject/room/class words equal to a name)`
      : "";
  console.log(`${findings.length || res.isError ? "❌" : "✅"} ${name.padEnd(24)} ${counts}${err}${noteText}`);
  for (const f of findings) console.log(`     ${f}`);
  if (findings.length || res.isError) problems++;
  return sc;
}

try {
  for (const [name, args] of calls) {
    const sc = await check(name, args);
    // Follow-up calls with ids from the lists
    if (name === "untis_get_timetable") {
      const lesson = (sc?.days as { lessons: { lessonRef: string }[] }[] | undefined)?.flatMap((d) => d.lessons)[0];
      if (lesson) await check("untis_get_lesson", { lessonRef: lesson.lessonRef });
    }
    if (name === "untis_list_messages" && OPEN_MESSAGE) {
      const msg = (sc?.messages as { messageId: number }[] | undefined)?.[0];
      if (msg) await check("untis_get_message", { messageId: msg.messageId });
    }
    if (name === "untis_list_homework") {
      const ref = (sc?.homework as { attachments?: { fileRef: string }[] }[] | undefined)?.flatMap((h) => h.attachments ?? [])[0];
      if (ref) await check("untis_download_file", { fileRef: ref.fileRef, mode: "text" });
    }
  }
} finally {
  await app.close();
}
console.log(problems ? `\n${problems} tool call(s) with findings or errors.` : "\nNo findings.");
process.exit(problems ? 1 : 0);

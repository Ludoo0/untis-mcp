/**
 * Timetable tools (spec 5.2, 5.3, 5.12): untis_get_timetable, untis_list_changes, untis_get_lesson.
 * Primary source: REST view API timetable/entries; fallback: JSON-RPC getTimetable.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GridEntry, GridPositionItem, RpcPeriod, TimetableDay } from "../api/types";
import type { AppContext } from "../context";
import { addDays, dateOf, daysBetween, fromUntisDate, hhmm, parseDateInput, timeOf, weekday } from "../dates";
import { ToolError } from "../errors";
import { log } from "../log";
import type { Named } from "../masterdata";
import type { ResourceStatus, TeacherDto } from "../redaction/people";
import { compact, dateInput, type FileRefDto, fileRefDto, resolveRange } from "./common";
import { handler, ok, READ_ONLY } from "./result";

export type LessonStatus = "regular" | "cancelled" | "substitution" | "room_change" | "changed" | "additional" | "moved" | "exam" | "event";

export type RoomDto = { short: string; name?: string; status?: ResourceStatus };

export type LessonDto = {
  lessonRef: string;
  date: string;
  start: string;
  end: string;
  periods?: string;
  subject?: Named;
  teachers: TeacherDto[];
  rooms: RoomDto[];
  classes?: string[];
  status: LessonStatus;
  kind?: string;
  substitutionText?: string;
  lessonText?: string;
  info?: string;
  notes?: string;
  homework?: boolean;
};

export type DayDto = { date: string; weekday: string; holiday?: string; noData?: boolean; lessons: LessonDto[] };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TEXT_LEN = 1_000;

// ---------- REST mapping ----------

type Res = NonNullable<GridPositionItem["current"]>;

function resStatus(r: Res, hasCounterpart: boolean, isRemovedSlot: boolean): ResourceStatus {
  const s = (r.status ?? "").toUpperCase();
  if (isRemovedSlot || s === "REMOVED") return "removed";
  if (hasCounterpart || s === "ADDED" || s === "SUBSTITUTION" || s === "CHANGED") return "substitute";
  return "regular";
}

function mapGridEntry(ctx: AppContext, date: string, e: GridEntry): LessonDto | undefined {
  const start = timeOf(e.duration?.start);
  const end = timeOf(e.duration?.end);
  const id = e.ids?.[0];
  if (!start || !end || id === undefined) return undefined;
  const people = ctx.redactor.people;

  const teachers: TeacherDto[] = [];
  const rooms: RoomDto[] = [];
  const classes: string[] = [];
  let subject: Named | undefined;
  let teacherChanged = false;
  let roomChanged = false;

  const items = [e.position1, e.position2, e.position3, e.position4, e.position5, e.position6, e.position7].flatMap((p) => p ?? []);
  for (const item of items) {
    const pairs: [Res, boolean][] = [];
    if (item.current) pairs.push([item.current, false]);
    if (item.removed) pairs.push([item.removed, true]);
    for (const [r, removedSlot] of pairs) {
      const type = (r.type ?? "").toUpperCase();
      const status = resStatus(r, !!(item.current && item.removed), removedSlot);
      if (type === "TEACHER") {
        teachers.push(people.teacher({ abbreviation: r.shortName, lastName: r.longName, status }));
        if (status !== "regular") teacherChanged = true;
      } else if (type === "ROOM") {
        rooms.push(
          compact({
            short: (r.shortName || r.longName || "").trim(),
            name: r.longName && r.longName !== r.shortName ? r.longName.trim() : undefined,
            status: status === "regular" ? undefined : status,
          }) as RoomDto,
        );
        if (status !== "regular") roomChanged = true;
      } else if (type === "SUBJECT" && !removedSlot) {
        const short = (r.shortName || r.longName || "").trim();
        subject = compact({ short, name: r.longName && r.longName !== r.shortName ? r.longName.trim() : undefined }) as Named;
      } else if (type === "CLASS" && !removedSlot && r.shortName) {
        classes.push(r.shortName.trim());
      }
    }
  }

  const status = (e.status ?? "").toUpperCase();
  const detail = (e.statusDetail ?? "").toUpperCase();
  const type = (e.type ?? "").toUpperCase();
  let lessonStatus: LessonStatus;
  if (status === "CANCELLED" || status === "REMOVED") lessonStatus = "cancelled";
  else if (status === "ADDITIONAL" || status === "ADDED") lessonStatus = "additional";
  else if (detail === "MOVED" || e.moved) lessonStatus = "moved";
  else if (status === "CHANGED" || detail === "SUBSTITUTED" || teacherChanged || roomChanged)
    lessonStatus = teacherChanged || detail === "SUBSTITUTED" ? "substitution" : roomChanged ? "room_change" : "changed";
  else if (type === "EXAM") lessonStatus = "exam";
  else if (type === "EVENT") lessonStatus = "event";
  else lessonStatus = "regular";

  const texts = new Map<string, string>();
  const addText = (k: string, v?: string | null) => {
    const t = ctx.redactor.optional(v, TEXT_LEN);
    if (t && ![...texts.values()].includes(t)) texts.set(k, t);
  };
  addText("substitutionText", e.substitutionText);
  addText("lessonText", e.lessonText);
  addText("info", e.lessonInfo);
  addText("notes", e.notesAll);
  for (const t of e.texts ?? []) {
    const k =
      t.type === "SUBSTITUTION_TEXT"
        ? "substitutionText"
        : t.type === "LESSON_INFO"
          ? "info"
          : t.type === "NOTES_FOR_ALL"
            ? "notes"
            : undefined;
    if (k && !texts.has(k)) addText(k, t.text);
  }

  return compact({
    lessonRef: `${date}_${id}`,
    date,
    start,
    end,
    periods: ctx.master().periodsFor(start, end),
    subject,
    teachers,
    rooms,
    classes: classes.length ? classes : undefined,
    status: lessonStatus,
    kind: type && type !== "NORMAL_TEACHING_PERIOD" ? type.toLowerCase() : undefined,
    substitutionText: texts.get("substitutionText"),
    lessonText: texts.get("lessonText"),
    info: texts.get("info"),
    notes: texts.get("notes"),
    homework: e.icons?.includes("HOMEWORK") ? true : undefined,
  }) as LessonDto;
}

// ---------- JSON-RPC fallback ----------

function mapRpcPeriod(ctx: AppContext, p: RpcPeriod): LessonDto | undefined {
  const date = fromUntisDate(p.date);
  const start = hhmm(p.startTime);
  const end = hhmm(p.endTime);
  if (!date || !start || !end) return undefined;
  const people = ctx.redactor.people;
  const teachers: TeacherDto[] = [];
  let teacherChanged = false;
  for (const t of p.te ?? []) {
    if (t.orgid) {
      teacherChanged = true;
      teachers.push(people.teacher({ id: t.orgid, abbreviation: t.orgname, status: "removed" }));
      if (t.id) teachers.push(people.teacher({ id: t.id, abbreviation: t.name, lastName: t.longname, status: "substitute" }));
    } else teachers.push(people.teacher({ id: t.id, abbreviation: t.name, lastName: t.longname }));
  }
  const rooms: RoomDto[] = [];
  let roomChanged = false;
  for (const r of p.ro ?? []) {
    if (r.orgid) {
      roomChanged = true;
      if (r.orgname) rooms.push({ short: r.orgname, status: "removed" });
      rooms.push(
        compact({ short: r.name ?? "", name: r.longname !== r.name ? r.longname : undefined, status: "substitute" as const }) as RoomDto,
      );
    } else rooms.push(compact({ short: r.name ?? "", name: r.longname !== r.name ? r.longname : undefined }) as RoomDto);
  }
  const su = p.su?.[0];
  const code = (p.code ?? "").toLowerCase();
  const status: LessonStatus =
    code === "cancelled"
      ? "cancelled"
      : teacherChanged
        ? "substitution"
        : roomChanged
          ? "room_change"
          : code === "irregular"
            ? "changed"
            : p.lstype === "ex"
              ? "exam"
              : "regular";
  return compact({
    lessonRef: `${date}_${p.id}`,
    date,
    start,
    end,
    periods: ctx.master().periodsFor(start, end),
    subject: su ? (compact({ short: su.name ?? "", name: su.longname !== su.name ? su.longname : undefined }) as Named) : undefined,
    teachers,
    rooms,
    classes: p.kl?.length ? p.kl.map((k) => k.name ?? "").filter(Boolean) : undefined,
    status,
    substitutionText: ctx.redactor.optional(p.substText, TEXT_LEN),
    lessonText: ctx.redactor.optional(p.lstext, TEXT_LEN),
    info: ctx.redactor.optional(p.info, TEXT_LEN),
  }) as LessonDto;
}

// ---------- Shared ----------

const signature = (l: LessonDto) =>
  JSON.stringify([
    l.subject?.short,
    l.teachers.map((t) => [t.name, t.status]),
    l.rooms.map((r) => [r.short, r.status]),
    l.status,
    l.substitutionText,
    l.info,
  ]);

/** Merges consecutive periods of the same lesson (double lessons) into one entry. */
function mergeDoubleLessons(ctx: AppContext, lessons: LessonDto[]): LessonDto[] {
  const out: LessonDto[] = [];
  for (const l of lessons) {
    const prev = out[out.length - 1];
    const adjacent =
      prev &&
      prev.date === l.date &&
      (prev.end === l.start ||
        (prev.periods && l.periods && Number(prev.periods.split("-").pop()) + 1 === Number(l.periods.split("-")[0])));
    if (prev && adjacent && signature(prev) === signature(l)) {
      prev.end = l.end;
      prev.periods = ctx.master().periodsFor(prev.start, prev.end) ?? prev.periods;
      if (l.homework) prev.homework = true;
      if (!prev.lessonText && l.lessonText) prev.lessonText = l.lessonText;
      continue;
    }
    out.push({ ...l, teachers: [...l.teachers], rooms: [...l.rooms] });
  }
  return out;
}

async function loadLessons(
  ctx: AppContext,
  start: string,
  end: string,
): Promise<{ lessons: LessonDto[]; noData: Set<string>; source: string }> {
  const me = ctx.me();
  try {
    const resourceId = (await ctx.untis.myTimetableResource().catch(() => undefined)) ?? me.studentId;
    const lessons: LessonDto[] = [];
    const noData = new Set<string>();
    // The REST API is queried per week (the web app does the same)
    for (let s = start; daysBetween(s, end) >= 0; s = addDays(s, 7)) {
      const e = daysBetween(addDays(s, 6), end) < 0 ? end : addDays(s, 6);
      const res = await ctx.untis.timetableEntries(s, e, resourceId);
      for (const day of res.days ?? []) lessons.push(...mapDay(ctx, day, noData));
    }
    return { lessons, noData, source: "rest" };
  } catch (e) {
    if (e instanceof ToolError && e.fatal) throw e;
    log.warn("timetable/entries failed – falling back to JSON-RPC getTimetable", { code: e instanceof ToolError ? e.code : "unknown" });
    const periods = await ctx.untis.rpcTimetable(me.studentId, start, end);
    const lessons = periods.map((p) => mapRpcPeriod(ctx, p)).filter((l): l is LessonDto => !!l);
    return { lessons, noData: new Set(), source: "rpc" };
  }
}

function mapDay(ctx: AppContext, day: TimetableDay, noData: Set<string>): LessonDto[] {
  const date = day.date?.slice(0, 10);
  if (!date) return [];
  if ((day.status ?? "").toUpperCase() === "NO_DATA") noData.add(date);
  return (day.gridEntries ?? []).map((g) => mapGridEntry(ctx, date, g)).filter((l): l is LessonDto => !!l);
}

const sortLessons = (a: LessonDto, b: LessonDto) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start);

export async function buildDays(
  ctx: AppContext,
  start: string,
  end: string,
  includeCancelled = true,
): Promise<{ days: DayDto[]; source: string }> {
  const { lessons, noData, source } = await loadLessons(ctx, start, end);
  const byDate = new Map<string, LessonDto[]>();
  for (const l of lessons.sort(sortLessons)) {
    if (!includeCancelled && l.status === "cancelled") continue;
    const list = byDate.get(l.date) ?? [];
    list.push(l);
    byDate.set(l.date, list);
  }
  const days: DayDto[] = [];
  for (let d = start; daysBetween(d, end) >= 0; d = addDays(d, 1)) {
    const list = mergeDoubleLessons(ctx, byDate.get(d) ?? []);
    const holiday = ctx.master().holidayOn(d);
    if (weekday(d) >= 5 && list.length === 0) continue; // weekend without lessons
    days.push(
      compact({
        date: d,
        weekday: WEEKDAYS[weekday(d)]!,
        holiday: holiday ? ctx.redactor.title(holiday.name) || "holiday" : undefined,
        noData: noData.has(d) && list.length === 0 ? true : undefined,
        lessons: list,
      }) as DayDto,
    );
  }
  return { days, source };
}

// ---------- Tools ----------

export const getTimetableInput = {
  startDate: dateInput("First day (default: Monday of the current week)"),
  endDate: dateInput("Last day (default: startDate + 6 days)"),
  includeCancelled: z.boolean().default(true).describe("Include cancelled lessons"),
};
type GetTimetableArgs = { startDate?: string; endDate?: string; includeCancelled?: boolean };

export async function getTimetable(ctx: AppContext, args: GetTimetableArgs) {
  const today = ctx.today();
  const monday = addDays(today, -weekday(today));
  const range = resolveRange(ctx, { startDate: args.startDate ?? monday, endDate: args.endDate }, { startOffset: 0, endOffset: 6 });
  const { days } = await buildDays(ctx, range.start, range.end, args.includeCancelled ?? true);
  const lessons = days.reduce((n, d) => n + d.lessons.length, 0);
  const changes = days.reduce((n, d) => n + d.lessons.filter((l) => l.status !== "regular" && l.status !== "exam").length, 0);
  return { startDate: range.start, endDate: range.end, days, lessons, changes };
}

export const listChangesInput = {
  startDate: dateInput("First day (default: today)"),
  days: z.number().int().min(1).max(31).default(7).describe("Number of days"),
};
type ListChangesArgs = { startDate?: string; days?: number };

export async function listChanges(ctx: AppContext, args: ListChangesArgs) {
  const start = parseDateInput(args.startDate, "startDate") ?? ctx.today();
  const end = addDays(start, (args.days ?? 7) - 1);
  const range = resolveRange(ctx, { startDate: start, endDate: end }, { startOffset: 0, endOffset: 6 });
  const { days } = await buildDays(ctx, range.start, range.end, true);
  const changes = days.flatMap((d) => d.lessons.filter((l) => l.status !== "regular" && l.status !== "exam"));
  return { startDate: range.start, endDate: range.end, changes, total: changes.length };
}

export const getLessonInput = {
  lessonRef: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}_\d+$/, "lessonRef from untis_get_timetable")
    .describe("lessonRef from untis_get_timetable / untis_list_changes"),
};

export type LessonDetailDto = LessonDto & {
  topic?: string;
  homeworkItems?: { text: string; due?: string; completed?: boolean }[];
  exam?: { name?: string; text?: string; type?: string };
  files?: FileRefDto[];
};

/** Finds the timetable entry of a lessonRef (date + period id) – also used by the file resolver. */
export async function findLessonEntry(ctx: AppContext, date: string, periodId: number) {
  const me = ctx.me();
  const resourceId = (await ctx.untis.myTimetableResource().catch(() => undefined)) ?? me.studentId;
  const res = await ctx.untis.timetableEntries(date, date, resourceId);
  for (const day of res.days ?? []) {
    for (const g of day.gridEntries ?? []) if (g.ids?.includes(periodId)) return { entry: g, resourceId };
  }
  return undefined;
}

export async function lessonDetailEntry(ctx: AppContext, date: string, periodId: number) {
  const found = await findLessonEntry(ctx, date, periodId);
  if (!found?.entry.duration?.start || !found.entry.duration.end)
    throw new ToolError("NOT_FOUND", "Lesson not found – fetch the timetable again.");
  const detail = await ctx.untis.calendarDetail(found.resourceId, found.entry.duration.start, found.entry.duration.end);
  const entries = detail.calendarEntries ?? [];
  return { found, detail: entries.find((c) => c.id === periodId) ?? entries[0] };
}

export async function getLesson(ctx: AppContext, args: { lessonRef: string }): Promise<LessonDetailDto> {
  const [date, idStr] = args.lessonRef.split("_");
  const periodId = Number(idStr);
  parseDateInput(date, "lessonRef");
  const { found, detail } = await lessonDetailEntry(ctx, date!, periodId);
  const base = mapGridEntry(ctx, date!, found.entry);
  if (!base) throw new ToolError("NOT_FOUND", "Lesson not found – fetch the timetable again.");
  if (!detail) return base;
  const files: FileRefDto[] = [...(detail.teachingContentFiles ?? []), ...(detail.notesAllFiles ?? [])].map((f, n) =>
    fileRefDto(ctx, { kind: "l", date: date!, periodId, n }, f.name ?? f.fileName),
  );
  const homework = (detail.homeworks ?? [])
    .map((h) => compact({ text: ctx.redactor.text(h.text, 2_000), due: dateOf(h.dueDateTime), completed: h.completed }))
    .filter((h) => h.text);
  return compact({
    ...base,
    topic: ctx.redactor.optional(detail.teachingContent, 2_000),
    notes: base.notes ?? ctx.redactor.optional(detail.notesAll, TEXT_LEN),
    info: base.info ?? ctx.redactor.optional(detail.lessonInfo, TEXT_LEN),
    substitutionText: base.substitutionText ?? ctx.redactor.optional(detail.substText, TEXT_LEN),
    homeworkItems: homework.length ? homework : undefined,
    exam: detail.exam
      ? compact({
          name: ctx.redactor.optional(detail.exam.name, 300),
          text: ctx.redactor.optional(detail.exam.text, TEXT_LEN),
          type: ctx.redactor.optional(detail.exam.examType, 100),
        })
      : undefined,
    files: files.length ? files : undefined,
  }) as LessonDetailDto;
}

const STATUS_HELP =
  'status: regular | cancelled | substitution (other teacher) | room_change | changed | additional | moved | exam | event. Teachers/rooms of a change carry status "removed" (original) or "substitute" (new).';

export function registerTimetableTools(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "untis_get_timetable",
    {
      title: "Timetable",
      description: `The student's timetable for a date range (default: current week, max. ${ctx.cfg.maxRangeDays} days), per day with lessons: time, periods, subject, teachers (last name + abbreviation), rooms, status and texts. Double lessons are merged. ${STATUS_HELP} Each lesson has a lessonRef for untis_get_lesson.`,
      inputSchema: getTimetableInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_get_timetable", async (args: GetTimetableArgs) => {
      const data = await getTimetable(ctx, args);
      return ok(`Timetable ${data.startDate} – ${data.endDate}: ${data.lessons} lessons, ${data.changes} changes.`, data);
    }),
  );

  server.registerTool(
    "untis_list_changes",
    {
      title: "Timetable changes",
      description: `Only the changed lessons (cancellations, substitutions, room changes, additional or moved lessons) for the next days (default: 7 from today). ${STATUS_HELP}`,
      inputSchema: listChangesInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_list_changes", async (args: ListChangesArgs) => {
      const data = await listChanges(ctx, args);
      return ok(`${data.total} changes ${data.startDate} – ${data.endDate}.`, data);
    }),
  );

  server.registerTool(
    "untis_get_lesson",
    {
      title: "Lesson details",
      description:
        "Details of one lesson by lessonRef: lesson topic (teaching content), notes, homework, exam info and attached files (fileRef → untis_download_file).",
      inputSchema: getLessonInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_get_lesson", async (args: { lessonRef: string }) => {
      const data = await getLesson(ctx, args);
      return ok(`Lesson ${data.date} ${data.start}–${data.end}${data.subject ? ` (${data.subject.short})` : ""}.`, data);
    }),
  );
}

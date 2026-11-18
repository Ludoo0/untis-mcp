/**
 * Homework, exams and absences (spec 5.4–5.6).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context";
import { addDays, dateOf, fromUntisDate, hhmm, timeOf } from "../dates";
import { ToolError } from "../errors";
import { log } from "../log";
import type { Named } from "../masterdata";
import type { TeacherDto } from "../redaction/people";
import { compact, dateInput, type FileRefDto, fileRefDto, resolveRange } from "./common";
import { handler, ok, READ_ONLY } from "./result";

const TEXT_LEN = 3_000;

// =====================================================================
// Homework
// =====================================================================

export type HomeworkDto = {
  homeworkId: number;
  assigned?: string;
  due?: string;
  subject?: Named;
  teacher?: TeacherDto;
  text: string;
  remark?: string;
  completed: boolean;
  attachments?: FileRefDto[];
};

export const listHomeworkInput = {
  startDate: dateInput("First day (default: 7 days ago)"),
  endDate: dateInput("Last day (default: 14 days ahead)"),
  openOnly: z.boolean().default(false).describe("Only homework not marked as completed"),
};
type ListHomeworkArgs = { startDate?: string; endDate?: string; openOnly?: boolean };

async function homeworkLegacy(ctx: AppContext, start: string, end: string): Promise<HomeworkDto[]> {
  const res = await ctx.untis.homeworksLegacy(start, end);
  const d = res.data ?? {};
  const subjectByLesson = new Map((d.lessons ?? []).map((l) => [l.id, l.subject]));
  const teacherByHw = new Map((d.records ?? []).filter((r) => r.homeworkId !== undefined).map((r) => [r.homeworkId!, r.teacherId]));
  const teacherNames = new Map((d.teachers ?? []).map((t) => [t.id, t.name]));
  return (d.homeworks ?? []).map((h) => {
    const assigned = fromUntisDate(h.date);
    const subjectName = h.lessonId !== undefined ? subjectByLesson.get(h.lessonId) : undefined;
    const teacherId = teacherByHw.get(h.id);
    const attachments = (h.attachments ?? []).map((a, n) =>
      fileRefDto(ctx, { kind: "h", date: assigned ?? "1970-01-01", homeworkId: h.id, n }, a.name),
    );
    return compact({
      homeworkId: h.id,
      assigned,
      due: fromUntisDate(h.dueDate),
      subject: subjectName ? subjectFromName(ctx, subjectName) : undefined,
      teacher: teacherId !== undefined ? ctx.redactor.people.teacher({ id: teacherId, lastName: teacherNames.get(teacherId) }) : undefined,
      text: ctx.redactor.text(h.text, TEXT_LEN),
      remark: ctx.redactor.optional(h.remark, TEXT_LEN),
      completed: !!h.completed,
      attachments: attachments.length ? attachments : undefined,
    }) as HomeworkDto;
  });
}

/** Legacy homework has the subject as a string (short or long name) → master data entry if known. */
function subjectFromName(ctx: AppContext, name: string): Named {
  const n = name.trim();
  for (const s of ctx.master().subjects.values()) if (s.short === n || s.name === n) return s;
  return { short: ctx.redactor.title(n, 60) };
}

async function homeworkIntern(ctx: AppContext, start: string, end: string): Promise<HomeworkDto[]> {
  const res = await ctx.untis.homework2017(ctx.me().studentId, start, end);
  const lessons = res.lessonsById ?? {};
  return (res.homeWorks ?? []).map((h) => {
    const lesson = h.lessonId !== undefined ? lessons[String(h.lessonId)] : undefined;
    const subject = lesson?.subjectId !== undefined ? ctx.master().subjects.get(lesson.subjectId) : undefined;
    const teacherId = lesson?.teacherIds?.[0];
    const assigned = dateOf(h.startDate);
    const attachments = (h.attachments ?? []).map((a, n) =>
      fileRefDto(ctx, { kind: "h", date: assigned ?? "1970-01-01", homeworkId: h.id, n }, a.name),
    );
    return compact({
      homeworkId: h.id,
      assigned,
      due: dateOf(h.endDate),
      subject,
      teacher: teacherId !== undefined ? ctx.redactor.people.teacher({ id: teacherId }) : undefined,
      text: ctx.redactor.text(h.text, TEXT_LEN),
      remark: ctx.redactor.optional(h.remark, TEXT_LEN),
      completed: !!h.completed,
      attachments: attachments.length ? attachments : undefined,
    }) as HomeworkDto;
  });
}

export async function loadHomework(ctx: AppContext, start: string, end: string): Promise<HomeworkDto[]> {
  let list: HomeworkDto[];
  try {
    list = await homeworkLegacy(ctx, start, end);
  } catch (e) {
    if (!ctx.untis.hasIntern || (e instanceof ToolError && e.fatal)) throw e;
    log.warn("Legacy homework failed – falling back to getHomeWork2017", { code: e instanceof ToolError ? e.code : "unknown" });
    list = await homeworkIntern(ctx, start, end);
  }
  return list.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.homeworkId - b.homeworkId);
}

export async function listHomework(ctx: AppContext, args: ListHomeworkArgs) {
  const { start, end } = resolveRange(ctx, args, { startOffset: -7, endOffset: 14 });
  let homework = await loadHomework(ctx, start, end);
  if (args.openOnly) homework = homework.filter((h) => !h.completed);
  return { startDate: start, endDate: end, homework, total: homework.length, open: homework.filter((h) => !h.completed).length };
}

// =====================================================================
// Exams
// =====================================================================

export type ExamDto = {
  examId: number;
  date: string;
  start?: string;
  end?: string;
  type?: string;
  name?: string;
  subject?: Named;
  teachers: TeacherDto[];
  rooms: string[];
  text?: string;
};

export const listExamsInput = {
  startDate: dateInput("First day (default: today)"),
  endDate: dateInput("Last day (default: 6 weeks ahead)"),
};
type ListExamsArgs = { startDate?: string; endDate?: string };

export async function loadExams(ctx: AppContext, start: string, end: string): Promise<ExamDto[]> {
  const people = ctx.redactor.people;
  const master = ctx.master();
  let exams: ExamDto[];
  if (ctx.untis.hasIntern) {
    const res = await ctx.untis.exams2017(ctx.me().studentId, start, end);
    exams = (res.exams ?? []).flatMap((x) => {
      const date = dateOf(x.startDateTime);
      if (!date) return [];
      return [
        compact({
          examId: x.id,
          date,
          start: timeOf(x.startDateTime),
          end: timeOf(x.endDateTime),
          type: ctx.redactor.optional(x.examType, 100),
          name: ctx.redactor.optional(x.name, 300),
          subject: x.subjectId !== undefined ? master.subjects.get(x.subjectId) : undefined,
          teachers: (x.teacherIds ?? []).map((id) => people.teacher({ id })),
          rooms: (x.roomIds ?? []).map((id) => master.rooms.get(id)?.short).filter((r): r is string => !!r),
          text: ctx.redactor.optional(x.text, TEXT_LEN),
        }) as ExamDto,
      ];
    });
  } else {
    // Password logins: legacy endpoint – allowlist mapping only (never participants, grades, compensation flags)
    const res = await ctx.untis.examsLegacy(ctx.me().classId, start, end);
    exams = (res.data?.exams ?? []).flatMap((x) => {
      const date = fromUntisDate(x.examDate);
      if (!date) return [];
      return [
        compact({
          examId: x.id,
          date,
          start: hhmm(x.startTime),
          end: hhmm(x.endTime),
          type: ctx.redactor.optional(x.examType, 100),
          name: ctx.redactor.optional(x.name, 300),
          subject: x.subject ? subjectFromName(ctx, x.subject) : undefined,
          teachers: (x.teachers ?? []).map((abbreviation) => people.teacher({ abbreviation })),
          rooms: (x.rooms ?? []).map((r) => ctx.redactor.title(r, 40)),
          text: ctx.redactor.optional(x.text, TEXT_LEN),
        }) as ExamDto,
      ];
    });
  }
  return exams.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? "").localeCompare(b.start ?? ""));
}

export async function listExams(ctx: AppContext, args: ListExamsArgs) {
  const { start, end } = resolveRange(ctx, args, { startOffset: 0, endOffset: 42 }, Math.max(ctx.cfg.maxRangeDays, 120));
  const exams = await loadExams(ctx, start, end);
  return { startDate: start, endDate: end, exams, total: exams.length };
}

// =====================================================================
// Absences
// =====================================================================

export type ExcuseStatus = "excused" | "unexcused" | "open";
export type AbsenceDto = {
  absenceId: number;
  startDate: string;
  startTime?: string;
  endDate: string;
  endTime?: string;
  excuseStatus: ExcuseStatus;
  reason?: string;
  text?: string;
};

export const listAbsencesInput = {
  startDate: dateInput("First day (default: start of the current school year)"),
  endDate: dateInput("Last day (default: today)"),
  status: z.enum(["all", "open", "excused", "unexcused"]).default("all").describe("Filter by excuse status"),
};
type ListAbsencesArgs = { startDate?: string; endDate?: string; status?: "all" | ExcuseStatus };

export async function listAbsences(ctx: AppContext, args: ListAbsencesArgs) {
  const today = ctx.today();
  const yearStart = ctx.master().schoolyearOn(today)?.start ?? addDays(today, -180);
  const { start, end } = resolveRange(
    ctx,
    { startDate: args.startDate ?? yearStart, endDate: args.endDate ?? today },
    { startOffset: 0, endOffset: 0 },
    400,
  );
  const drop = ctx.cfg.absenceTexts === "drop";
  const master = ctx.master();
  let absences: AbsenceDto[];

  if (ctx.untis.hasIntern) {
    const res = await ctx.untis.absences2017(start, end);
    absences = (res.absences ?? []).flatMap((a) => {
      const startDate = dateOf(a.startDateTime);
      const endDate = dateOf(a.endDateTime) ?? startDate;
      if (!startDate || !endDate) return [];
      const statusInfo = a.excuse?.excuseStatusId !== undefined ? master.excuseStatuses.get(a.excuse.excuseStatusId) : undefined;
      const excuseStatus: ExcuseStatus = a.excused || statusInfo?.excused ? "excused" : a.excuse ? "unexcused" : "open";
      const reason = a.absenceReason || (a.absenceReasonId !== undefined ? master.absenceReasons.get(a.absenceReasonId) : undefined);
      return [
        compact({
          absenceId: a.id,
          startDate,
          startTime: timeOf(a.startDateTime),
          endDate,
          endTime: timeOf(a.endDateTime),
          excuseStatus,
          reason: drop ? undefined : ctx.redactor.optional(reason, 200),
          text: drop ? undefined : ctx.redactor.optional([a.text, a.excuse?.text].filter(Boolean).join("\n"), 1_000),
        }) as AbsenceDto,
      ];
    });
  } else {
    const res = await ctx.untis.absencesLegacy(ctx.me().studentId, start, end);
    absences = (res.data?.absences ?? []).flatMap((a) => {
      const startDate = fromUntisDate(a.startDate);
      const endDate = fromUntisDate(a.endDate) ?? startDate;
      if (!startDate || !endDate) return [];
      const excuseStatus: ExcuseStatus = a.isExcused ? "excused" : a.excuseStatus ? "unexcused" : "open";
      return [
        compact({
          absenceId: a.id,
          startDate,
          startTime: hhmm(a.startTime),
          endDate,
          endTime: hhmm(a.endTime),
          excuseStatus,
          reason: drop ? undefined : ctx.redactor.optional(a.reason, 200),
          text: drop ? undefined : ctx.redactor.optional(a.text, 1_000),
        }) as AbsenceDto,
      ];
    });
  }
  absences.sort((a, b) => b.startDate.localeCompare(a.startDate) || (b.startTime ?? "").localeCompare(a.startTime ?? ""));
  const totals = {
    count: absences.length,
    open: absences.filter((a) => a.excuseStatus === "open").length,
    excused: absences.filter((a) => a.excuseStatus === "excused").length,
    unexcused: absences.filter((a) => a.excuseStatus === "unexcused").length,
  };
  const status = args.status ?? "all";
  if (status !== "all") absences = absences.filter((a) => a.excuseStatus === status);
  return { startDate: start, endDate: end, absences, totals };
}

// =====================================================================
// Registration
// =====================================================================

export function registerSchoolworkTools(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "untis_list_homework",
    {
      title: "Homework",
      description:
        "Homework from the class register for a date range (default: 7 days back to 14 days ahead), sorted by due date: subject, teacher, text, due date, completed flag, attachments (fileRef → untis_download_file).",
      inputSchema: listHomeworkInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_list_homework", async (args: ListHomeworkArgs) => {
      const data = await listHomework(ctx, args);
      return ok(`${data.total} homework entries (${data.open} open), ${data.startDate} – ${data.endDate}.`, data);
    }),
  );

  server.registerTool(
    "untis_list_exams",
    {
      title: "Exams",
      description:
        "Exams (Klausuren, tests) of the student for a date range (default: today to 6 weeks ahead): date, time, type, name, subject, teachers, rooms. No participant lists and no grades.",
      inputSchema: listExamsInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_list_exams", async (args: ListExamsArgs) => {
      const data = await listExams(ctx, args);
      return ok(`${data.total} exams ${data.startDate} – ${data.endDate}.`, data);
    }),
  );

  server.registerTool(
    "untis_list_absences",
    {
      title: "Absences",
      description:
        "The student's own absences (default: current school year) with excuse status (excused/unexcused/open) and totals. Caution: absence reasons and texts can be health data – only use them if the user asks for them.",
      inputSchema: listAbsencesInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_list_absences", async (args: ListAbsencesArgs) => {
      const data = await listAbsences(ctx, args);
      return ok(
        `${data.totals.count} absences (${data.totals.open} open, ${data.totals.unexcused} unexcused), ${data.startDate} – ${data.endDate}.`,
        data,
      );
    }),
  );
}

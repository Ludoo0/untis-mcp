/**
 * untis_overview (spec 5.1) and untis_get_master_data (5.10).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context";
import { addDays, weekday } from "../dates";
import { compact } from "./common";
import { listMessages, messagesOfDay } from "./messages";
import { bestEffort, handler, ok, READ_ONLY } from "./result";
import { loadExams, loadHomework } from "./schoolwork";
import { buildDays, type LessonDto } from "./timetable";

export const overviewInput = {
  days: z.number().int().min(1).max(5).default(2).describe("Number of school days (from today)"),
};

export async function overview(ctx: AppContext, args: { days?: number }) {
  const warnings: string[] = [];
  const today = ctx.today();
  const nowTime = ctx.nowTime();
  const wanted = args.days ?? 2;

  // School days: skip weekends and holidays (look ahead up to 14 days)
  const schoolDays: string[] = [];
  for (let d = today; schoolDays.length < wanted && schoolDays.length < 14; d = addDays(d, 1)) {
    if (addDays(today, 14) < d) break;
    if (weekday(d) < 5 && !ctx.master().holidayOn(d)) schoolDays.push(d);
  }
  const lastDay = schoolDays[schoolDays.length - 1] ?? today;

  const tt = await bestEffort(warnings, "timetable", () => buildDays(ctx, today, lastDay));
  const days = (tt?.days ?? [])
    .filter((d) => schoolDays.includes(d.date))
    .map((d) => {
      const lessons = d.lessons.filter((l) => l.status !== "cancelled");
      const first = lessons[0];
      const last = lessons[lessons.length - 1];
      const next = d.date === today ? lessons.find((l) => l.end > nowTime) : undefined;
      return compact({
        date: d.date,
        weekday: d.weekday,
        lessons: lessons.length,
        firstLesson: first ? `${first.start}${first.subject ? ` ${first.subject.short}` : ""}` : undefined,
        lastLessonEnds: last?.end,
        nextLesson: next ? lessonSummary(next) : undefined,
        changes: d.lessons.filter((l) => l.status !== "regular" && l.status !== "exam"),
      });
    });

  const homework = await bestEffort(warnings, "homework", () => loadHomework(ctx, addDays(today, -7), addDays(lastDay, 1)));
  const homeworkDue = (homework ?? []).filter((h) => !h.completed && h.due && h.due >= today && h.due <= addDays(lastDay, 1));
  const exams = await bestEffort(warnings, "exams", () => loadExams(ctx, today, addDays(today, 14)));
  const messages = await bestEffort(warnings, "messages", () => listMessages(ctx, { unreadOnly: true, limit: 5 }));
  const motd = await bestEffort(warnings, "messagesOfDay", () => messagesOfDay(ctx, { date: today }));

  return compact({
    today,
    days,
    homeworkDue,
    upcomingExams: exams ?? [],
    unreadMessages: messages?.unread,
    unreadPreview: messages?.messages,
    messagesOfDay: motd?.items,
    warnings: warnings.length ? warnings : undefined,
  });
}

function lessonSummary(l: LessonDto) {
  return compact({
    start: l.start,
    end: l.end,
    subject: l.subject?.short,
    teachers: l.teachers.filter((t) => t.status !== "removed").map((t) => t.name),
    rooms: l.rooms.filter((r) => r.status !== "removed").map((r) => r.short),
    status: l.status,
  });
}

const MASTER_PARTS = ["subjects", "teachers", "rooms", "classes", "timegrid", "holidays", "schoolyears"] as const;
type MasterPart = (typeof MASTER_PARTS)[number];

export const masterDataInput = {
  include: z
    .array(z.enum(MASTER_PARTS))
    .default(["subjects", "teachers", "timegrid", "holidays", "schoolyears"])
    .describe("Which lists to return"),
};

export function masterData(ctx: AppContext, args: { include?: MasterPart[] }) {
  const m = ctx.master();
  const want = new Set(args.include ?? ["subjects", "teachers", "timegrid", "holidays", "schoolyears"]);
  const today = ctx.today();
  const people = ctx.redactor.people;
  const out: Record<string, unknown> = {};
  if (want.has("subjects")) out.subjects = [...m.subjects.values()].sort((a, b) => a.short.localeCompare(b.short));
  if (want.has("teachers")) {
    const seen = new Set<string>();
    out.teachers = m.teachers
      .filter((t) => t.active !== false)
      .map((t) => people.teacher({ id: t.id, abbreviation: t.name }))
      .filter((t) => {
        const k = `${t.name}|${t.abbreviation ?? ""}`;
        return !seen.has(k) && seen.add(k);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (want.has("rooms")) out.rooms = [...m.rooms.values()].sort((a, b) => a.short.localeCompare(b.short));
  if (want.has("classes")) out.classes = [...m.classes.values()].sort((a, b) => a.short.localeCompare(b.short));
  if (want.has("timegrid")) out.timegrid = m.timegrid;
  if (want.has("holidays"))
    out.holidays = m.holidays.filter((h) => h.end >= addDays(today, -30)).map((h) => ({ ...h, name: ctx.redactor.title(h.name) }));
  if (want.has("schoolyears")) {
    out.schoolyears = m.schoolyears;
    out.currentSchoolyear = m.schoolyearOn(today);
  }
  const me = ctx.me();
  if (me.classId !== undefined) out.ownClass = m.classes.get(me.classId);
  return out;
}

export function registerOverviewTools(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "untis_overview",
    {
      title: "Overview",
      description:
        "Start here: today and the next school day(s) – number of lessons, first lesson, next lesson, timetable changes – plus homework due, exams in the next 14 days, unread messages and today's messages of the day.",
      inputSchema: overviewInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_overview", async (args: { days?: number }) => {
      const data = await overview(ctx, args);
      const changes = (data.days as { changes: unknown[] }[]).reduce((n, d) => n + d.changes.length, 0);
      return ok(
        `Overview ${data.today}: ${changes} changes, ${(data.homeworkDue as unknown[]).length} homework due, ${(data.upcomingExams as unknown[]).length} exams in 14 days, ${data.unreadMessages ?? "?"} unread messages.`,
        data,
      );
    }),
  );

  server.registerTool(
    "untis_get_master_data",
    {
      title: "Master data",
      description:
        "Subjects (abbreviation + name), teachers (last name + abbreviation, never first names), rooms, classes, time grid (periods with times), holidays and school years.",
      inputSchema: masterDataInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_get_master_data", async (args: { include?: MasterPart[] }) => ok("Master data.", masterData(ctx, args))),
  );
}

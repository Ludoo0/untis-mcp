import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/app";
import { ToolError } from "../src/errors";
import { downloadFile } from "../src/tools/files";
import { getMessage, listMessages, messagesOfDay } from "../src/tools/messages";
import { masterData, overview } from "../src/tools/overview";
import { listAbsences, listExams, listHomework } from "../src/tools/schoolwork";
import { getLesson, getTimetable, listChanges } from "../src/tools/timetable";
import { FORBIDDEN, readyContext, SELF } from "./fixtures";

describe("untis_get_timetable", () => {
  test("maps lessons, merges double lessons, resolves periods", async () => {
    const ctx = await readyContext();
    const res = await getTimetable(ctx, { startDate: "2026-11-18", endDate: "2026-11-19" });
    expect(res.days.map((d) => d.date)).toEqual(["2026-11-18", "2026-11-19"]);
    const [maths, english, german] = res.days[0]!.lessons;
    expect(maths).toMatchObject({
      start: "08:00",
      end: "09:30",
      periods: "1-2",
      subject: { short: "M", name: "Mathematik" },
      status: "regular",
      homework: true,
    });
    expect(maths!.teachers).toEqual([{ name: "Lindqvist", abbreviation: "LIN" }]);
    expect(maths!.lessonRef).toBe("2026-11-18_9001");
    expect(english).toMatchObject({ status: "substitution", periods: "3" });
    expect(english!.teachers).toEqual([
      { name: "Müller", abbreviation: "MÜL", status: "substitute" },
      { name: "Okafor", abbreviation: "OKA", status: "removed" },
    ]);
    expect(english!.substitutionText).toMatch(/^Vertretung durch Müller, Schüler:in-[0-9A-F]{4} bringt die Liste mit$/);
    expect(german!.status).toBe("cancelled");
    expect(res.days[1]!.lessons[0]).toMatchObject({ status: "room_change" });
    expect(res.days[1]!.lessons[0]!.rooms).toEqual([
      { short: "R202", name: "Raum 202", status: "substitute" },
      { short: "R101", name: "Raum 101", status: "removed" },
    ]);
    expect(res.days[1]!.lessons[0]!.info).toBe("Bitte Lindqvist Bescheid geben: [E-Mail]");
    expect(res).toMatchObject({ lessons: 4, changes: 3 });
  });

  test("default range: the current week (Monday–Sunday, weekend days without lessons omitted)", async () => {
    const res = await getTimetable(await readyContext(), {});
    expect(res.startDate).toBe("2026-11-16");
    expect(res.endDate).toBe("2026-11-22");
    expect(res.days.map((d) => d.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });

  test("includeCancelled=false hides cancellations", async () => {
    const res = await getTimetable(await readyContext(), { startDate: "2026-11-18", endDate: "2026-11-18", includeCancelled: false });
    expect(res.days[0]!.lessons.map((l) => l.status)).toEqual(["regular", "substitution"]);
  });

  test("range limit", async () => {
    await expect(getTimetable(await readyContext(), { startDate: "2026-11-01", endDate: "2026-12-31" })).rejects.toMatchObject({
      code: "RANGE_TOO_LARGE",
    });
  });

  test("falls back to JSON-RPC getTimetable", async () => {
    const ctx = await readyContext({
      timetableEntries: async () => {
        throw new ToolError("NO_RIGHT", "x");
      },
      rpcTimetable: async () => [
        {
          id: 5,
          date: 20261118,
          startTime: 800,
          endTime: 845,
          su: [{ id: 301, name: "M", longname: "Mathematik" }],
          te: [{ id: 12, name: "MÜL", longname: "Müller", orgid: 13, orgname: "OKA" }],
          ro: [{ id: 201, name: "R101", longname: "Raum 101" }],
        },
        { id: 6, date: 20261118, startTime: 845, endTime: 930, code: "cancelled", su: [{ id: 302, name: "D" }], te: [], ro: [] },
      ],
    });
    const res = await getTimetable(ctx, { startDate: "2026-11-18", endDate: "2026-11-18" });
    const [a, b] = res.days[0]!.lessons;
    expect(a).toMatchObject({ status: "substitution", periods: "1" });
    expect(a!.teachers).toEqual([
      { name: "Okafor", abbreviation: "OKA", status: "removed" },
      { name: "Müller", abbreviation: "MÜL", status: "substitute" },
    ]);
    expect(b!.status).toBe("cancelled");
  });
});

describe("untis_list_changes / untis_get_lesson", () => {
  test("only changed lessons", async () => {
    const res = await listChanges(await readyContext(), { startDate: "2026-11-18", days: 2 });
    expect(res.changes.map((c) => c.status)).toEqual(["substitution", "cancelled", "room_change"]);
  });

  test("lesson details: topic, homework, files – never staff notes or students", async () => {
    const res = await getLesson(await readyContext(), { lessonRef: "2026-11-18_9003" });
    expect(res.topic).toBe("Unit 3 – Ich presents, see [Link entfernt]");
    expect(res.homeworkItems).toEqual([{ text: "Workbook p. 12", due: "2026-11-20", completed: false }]);
    expect(res.files![0]).toMatchObject({ fileRef: "l_20261118_9003_0", kind: "file" });
    expect(res.files![0]!.name).toMatch(/^Schüler:in-[0-9A-F]{4}_Arbeitsblatt\.pdf$/);
    expect(JSON.stringify(res)).not.toMatch(/Leonhard|Quast|intern/);
  });

  test("unknown lesson", async () => {
    await expect(getLesson(await readyContext(), { lessonRef: "2026-11-18_1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("homework, exams, absences", () => {
  test("homework: subject, teacher by id, redacted text, attachments", async () => {
    const res = await listHomework(await readyContext(), {});
    expect(res).toMatchObject({ startDate: "2026-11-11", endDate: "2026-12-02", total: 2, open: 1 });
    const [first] = res.homework;
    expect(first).toMatchObject({ homeworkId: 802, completed: true });
    const open = res.homework.find((h) => h.homeworkId === 801)!;
    expect(open).toMatchObject({
      assigned: "2026-11-17",
      due: "2026-11-20",
      subject: { short: "D", name: "Deutsch" },
      teacher: { name: "Okafor", abbreviation: "OKA" },
    });
    expect(open.text).toBe("Aufgabe 4 – bei Fragen an Frau Okafor");
    expect(open.attachments![0]).toMatchObject({ fileRef: "h_20261117_801_0" });
    expect((await listHomework(await readyContext(), { openOnly: true })).homework.map((h) => h.homeworkId)).toEqual([801]);
  });

  test("exams from the mobile API – no participants", async () => {
    const res = await listExams(await readyContext(), {});
    expect(res.exams).toEqual([
      {
        examId: 601,
        date: "2026-11-25",
        start: "08:00",
        end: "09:30",
        type: "Klausur",
        name: "Klausur Nr. 2",
        subject: { short: "M", name: "Mathematik" },
        teachers: [{ name: "Lindqvist", abbreviation: "LIN" }],
        rooms: ["R101"],
      },
    ]);
  });

  test("absences with excuse status, totals and redacted texts", async () => {
    const res = await listAbsences(await readyContext(), {});
    expect(res.startDate).toBe("2026-08-01");
    expect(res.totals).toEqual({ count: 2, open: 1, excused: 1, unexcused: 0 });
    expect(res.absences[1]).toMatchObject({
      absenceId: 701,
      startDate: "2026-10-05",
      startTime: "08:00",
      excuseStatus: "excused",
      reason: "Krankheit",
    });
    expect(res.absences[1]!.text).toMatch(/^Attest liegt vor, Schüler:in-[0-9A-F]{4} hat es abgegeben$/);
    const dropped = await listAbsences(await readyContext({}, { absenceTexts: "drop" }), { status: "excused" });
    expect(dropped.absences).toEqual([
      { absenceId: 701, startDate: "2026-10-05", startTime: "08:00", endDate: "2026-10-05", endTime: "13:00", excuseStatus: "excused" },
    ]);
  });
});

describe("messages", () => {
  test("list: teacher sender by last name, parent as pseudonym, names in previews redacted", async () => {
    const res = await listMessages(await readyContext(), {});
    expect(res).toMatchObject({ total: 2, unread: 1, hasMore: false });
    const [a, b] = res.messages;
    expect(a).toMatchObject({
      messageId: 1001,
      sent: "2026-11-17 18:00",
      from: { display: "Müller", role: "teacher" },
      read: false,
      hasAttachments: true,
    });
    expect(a!.preview).toBe("Liebe Eltern, … Ihr Müller");
    expect(b!.from!.display).toMatch(/^Elternteil-[0-9A-F]{4}$/);
    expect(b!.preview).toBe(`Hallo, hier ist ${b!.from!.display}`);
  });

  test("detail: HTML → text, contacts removed, attachments as fileRefs", async () => {
    const res = await getMessage(await readyContext(), { messageId: 1001 });
    expect(res.text).toBe("Liebe Eltern,\nder Elternabend ist am 26.11. Rückfragen an [E-Mail] oder [Telefon].\nIhr Müller");
    expect(res.attachments).toEqual([{ fileRef: "m_1001_0", name: "Einladung Müller.pdf", kind: "file" }]);
    expect(res.recipients).toBe(1);
  });

  test("messages of the day", async () => {
    const res = await messagesOfDay(await readyContext(), {});
    expect(res).toMatchObject({ date: "2026-11-18", total: 1 });
    expect(res.items[0]).toEqual({ subject: "Hitzefrei", text: "**Ab 12 Uhr** frei – Info von Lindqvist" });
  });
});

describe("overview and master data", () => {
  test("overview combines today and the next school day", async () => {
    const res = await overview(await readyContext(), {});
    expect(res.today).toBe("2026-11-18");
    expect((res.days as { date: string }[]).map((d) => d.date)).toEqual(["2026-11-18", "2026-11-19"]);
    expect(res.days[0]).toMatchObject({
      lessons: 2,
      firstLesson: "08:00 M",
      nextLesson: { start: "08:00", subject: "M", teachers: ["Lindqvist"] },
    });
    expect((res.homeworkDue as { homeworkId: number }[]).map((h) => h.homeworkId)).toEqual([801]);
    expect(res.unreadMessages).toBe(1);
    expect(res.warnings).toBeUndefined();
  });

  test("a failing part becomes a warning", async () => {
    const ctx = await readyContext({
      messages: async () => {
        throw new ToolError("NO_RIGHT", "x");
      },
    });
    const res = await overview(ctx, {});
    expect(res.warnings).toEqual(["messages: NO_RIGHT"]);
  });

  test("master data: teachers without first names", async () => {
    const res = masterData(await readyContext(), { include: ["teachers", "timegrid", "schoolyears", "holidays"] });
    expect(res.teachers).toEqual([
      { name: "Lindqvist", abbreviation: "LIN" },
      { name: "Müller", abbreviation: "MÜL" },
      { name: "Okafor", abbreviation: "OKA" },
    ]);
    expect((res.timegrid as unknown[]).length).toBe(4);
    expect(res.currentSchoolyear).toMatchObject({ name: "2026/2027" });
    expect(res.ownClass).toEqual({ short: "7b", name: "Klasse 7b" });
  });
});

describe("untis_download_file", () => {
  test("text files are returned redacted", async () => {
    const res = await downloadFile(await readyContext(), { fileRef: "m_1001_0" });
    const sc = res.structuredContent as { text?: string; name: string; blobIncluded: boolean };
    expect(sc.text).toBe("Einladung von Müller für Ich");
    expect(sc.name).toBe("Einladung Müller.pdf");
    expect(sc.blobIncluded).toBe(false);
  });

  test("invalid fileRef", async () => {
    await expect(downloadFile(await readyContext(), { fileRef: "x_1" })).rejects.toMatchObject({ code: "FILE_REF_UNKNOWN" });
    await expect(downloadFile(await readyContext(), { fileRef: "m_1001_9" })).rejects.toMatchObject({ code: "FILE_REF_UNKNOWN" });
  });
});

describe("MCP protocol + leak test", () => {
  test("all tools via MCP: no forbidden names, no ids, no secrets", async () => {
    const ctx = await readyContext();
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "untis_download_file",
      "untis_get_lesson",
      "untis_get_master_data",
      "untis_get_message",
      "untis_get_timetable",
      "untis_list_absences",
      "untis_list_changes",
      "untis_list_exams",
      "untis_list_homework",
      "untis_list_messages",
      "untis_messages_of_day",
      "untis_overview",
    ]);
    for (const t of tools.tools) expect(t.annotations?.readOnlyHint).toBe(true);

    const calls: [string, Record<string, unknown>][] = [
      ["untis_overview", {}],
      ["untis_get_timetable", { startDate: "2026-11-16", endDate: "2026-11-20" }],
      ["untis_list_changes", {}],
      ["untis_get_lesson", { lessonRef: "2026-11-18_9003" }],
      ["untis_list_homework", {}],
      ["untis_list_exams", {}],
      ["untis_list_absences", {}],
      ["untis_list_messages", {}],
      ["untis_get_message", { messageId: 1001 }],
      ["untis_messages_of_day", {}],
      ["untis_get_master_data", { include: ["subjects", "teachers", "rooms", "classes", "timegrid", "holidays", "schoolyears"] }],
      ["untis_download_file", { fileRef: "m_1001_0" }],
    ];
    for (const [name, args] of calls) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, `${name} failed: ${JSON.stringify(r.content)}`).toBeFalsy();
      const out = JSON.stringify(r);
      for (const n of FORBIDDEN) expect(out, `${name} leaks "${n}"`).not.toMatch(new RegExp(`(?<![\\p{L}])${n}(?![\\p{L}])`, "u"));
      expect(out, `${name} leaks the student id`).not.toContain(String(SELF.id));
      expect(out).not.toMatch(/amazonaws|X-Amz|webuntis\.(com|example)|token=|personId|studentId|userId/i);
    }
    await client.close();
  });

  test("structured error for invalid input", async () => {
    const ctx = await readyContext();
    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const r = await client.callTool({ name: "untis_list_homework", arguments: { startDate: "2026-02-30" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.structuredContent)).toContain("INVALID_INPUT");
    await client.close();
  });
});

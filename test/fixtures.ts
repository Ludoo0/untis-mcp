/**
 * Fictional test data and a fake WebUntis API. Never put real data here.
 */
import type { UntisApi } from "../src/context";
import { createContext } from "../src/context";
import { FileService } from "../src/files/service";
import { LABELS } from "../src/redaction/labels";
import { PersonRegistry } from "../src/redaction/people";
import { Redactor } from "../src/redaction/redactor";
import { TeacherDirectory } from "../src/redaction/teachers";

export const SELF = { id: 501, foreName: "Jonas", longName: "Beispielmann" };
export const STUDENTS = [
  { id: 501, key: "k1", name: "BeispJon", foreName: "Jonas", longName: "Beispielmann" },
  { id: 502, key: "k2", name: "SonnMia", foreName: "Mia", longName: "Sonnberg" },
  { id: 503, key: "k3", name: "MuelLea", foreName: "Lea", longName: "Müller" },
  { id: 504, key: "k4", name: "FiscLeo", foreName: "Leonhard", longName: "Quast" },
];
export const TEACHERS = [
  { id: 11, name: "LIN", firstName: "Sabine", lastName: "Lindqvist", active: true },
  { id: 12, name: "MÜL", firstName: "Hans", lastName: "Müller", active: true },
  { id: 13, name: "OKA", firstName: "Petra", lastName: "Okafor", active: true },
];
/** Names that must never appear in any tool output. */
export const FORBIDDEN = [
  "Sabine",
  "Hans",
  "Petra",
  "Jonas",
  "Beispielmann",
  "Mia",
  "Sonnberg",
  "Lea",
  "Leonhard",
  "Quast",
  "Ottilie",
  "Brennecke",
];

export const TODAY = "2026-11-18"; // Wednesday
export const NOW = new Date("2026-11-18T08:30:00+01:00");

const masterData = {
  timeStamp: 1,
  absenceReasons: [{ id: 1, name: "krank", longName: "Krankheit", active: true }],
  excuseStatuses: [
    { id: 1, name: "ent", longName: "entschuldigt", excused: true, active: true },
    { id: 2, name: "nent", longName: "nicht entschuldigt", excused: false, active: true },
  ],
  holidays: [{ id: 1, name: "WF", longName: "Weihnachtsferien", startDate: "2026-12-21", endDate: "2027-01-05" }],
  klassen: [{ id: 70, name: "7b", longName: "Klasse 7b", active: true }],
  rooms: [
    { id: 201, name: "R101", longName: "Raum 101" },
    { id: 202, name: "R202", longName: "Raum 202" },
  ],
  subjects: [
    { id: 301, name: "M", longName: "Mathematik" },
    { id: 302, name: "D", longName: "Deutsch" },
    { id: 303, name: "E", longName: "Englisch" },
  ],
  teachers: TEACHERS,
  schoolyears: [{ id: 9, name: "2026/2027", startDate: "2026-08-01", endDate: "2027-07-31" }],
  timeGrid: {
    days: [
      {
        day: "MO",
        units: [
          { label: "1", startTime: "T0800", endTime: "T0845" },
          { label: "2", startTime: "T0845", endTime: "T0930" },
          { label: "3", startTime: "T0950", endTime: "T1035" },
          { label: "4", startTime: "T1035", endTime: "T1120" },
        ],
      },
    ],
  },
};

export const loginResult = {
  masterData,
  userData: { elemType: "STUDENT", elemId: SELF.id, displayName: "Beispielmann Jonas", klassenIds: [], rights: [] },
  settings: {},
};

const res = (type: string, shortName: string, longName: string, status = "REGULAR") => ({
  type,
  status,
  shortName,
  longName,
  displayName: longName,
  displayNameLabel: "",
});

export const timetableEntries = {
  format: 1,
  days: [
    {
      date: "2026-11-18",
      resourceType: "STUDENT",
      status: "REGULAR",
      dayEntries: [],
      backEntries: [],
      gridEntries: [
        // Double lesson maths (two periods), regular
        {
          ids: [9001],
          duration: { start: "2026-11-18T08:00", end: "2026-11-18T08:45" },
          type: "NORMAL_TEACHING_PERIOD",
          status: "REGULAR",
          position1: [{ current: res("TEACHER", "LIN", "Lindqvist"), removed: null }],
          position2: [{ current: res("SUBJECT", "M", "Mathematik"), removed: null }],
          position3: [{ current: res("ROOM", "R101", "Raum 101"), removed: null }],
          icons: ["HOMEWORK"],
          texts: [],
        },
        {
          ids: [9002],
          duration: { start: "2026-11-18T08:45", end: "2026-11-18T09:30" },
          type: "NORMAL_TEACHING_PERIOD",
          status: "REGULAR",
          position1: [{ current: res("TEACHER", "LIN", "Lindqvist"), removed: null }],
          position2: [{ current: res("SUBJECT", "M", "Mathematik"), removed: null }],
          position3: [{ current: res("ROOM", "R101", "Raum 101"), removed: null }],
          texts: [],
        },
        // Substitution: Müller instead of Okafor, with a text mentioning names
        {
          ids: [9003],
          duration: { start: "2026-11-18T09:50", end: "2026-11-18T10:35" },
          type: "NORMAL_TEACHING_PERIOD",
          status: "CHANGED",
          position1: [{ current: res("TEACHER", "MÜL", "Müller", "ADDED"), removed: res("TEACHER", "OKA", "Okafor", "REMOVED") }],
          position2: [{ current: res("SUBJECT", "E", "Englisch"), removed: null }],
          position3: [{ current: res("ROOM", "R202", "Raum 202"), removed: null }],
          substitutionText: "Vertretung durch Hans Müller, Mia Sonnberg bringt die Liste mit",
          texts: [{ type: "SUBSTITUTION_TEXT", text: "Vertretung durch Hans Müller, Mia Sonnberg bringt die Liste mit" }],
        },
        // Cancelled
        {
          ids: [9004],
          duration: { start: "2026-11-18T10:35", end: "2026-11-18T11:20" },
          type: "NORMAL_TEACHING_PERIOD",
          status: "CANCELLED",
          position1: [{ current: res("TEACHER", "OKA", "Okafor"), removed: null }],
          position2: [{ current: res("SUBJECT", "D", "Deutsch"), removed: null }],
          position3: [{ current: res("ROOM", "R101", "Raum 101"), removed: null }],
          texts: [],
        },
      ],
    },
    {
      date: "2026-11-19",
      resourceType: "STUDENT",
      status: "REGULAR",
      gridEntries: [
        // Room change
        {
          ids: [9101],
          duration: { start: "2026-11-19T08:00", end: "2026-11-19T08:45" },
          type: "NORMAL_TEACHING_PERIOD",
          status: "CHANGED",
          position1: [{ current: res("TEACHER", "OKA", "Okafor"), removed: null }],
          position2: [{ current: res("SUBJECT", "D", "Deutsch"), removed: null }],
          position3: [{ current: res("ROOM", "R202", "Raum 202", "ADDED"), removed: res("ROOM", "R101", "Raum 101", "REMOVED") }],
          lessonInfo: "Bitte Sabine Lindqvist Bescheid geben: sabine.lindqvist@example.org",
          texts: [],
        },
      ],
    },
  ],
  errors: [],
};

export const calendarDetail = {
  calendarEntries: [
    {
      id: 9003,
      startDateTime: "2026-11-18T09:50",
      endDateTime: "2026-11-18T10:35",
      status: "SUBSTITUTION",
      teachingContent: "Unit 3 – Jonas Beispielmann presents, see https://webuntis.example/WebUntis/x?token=abc",
      notesAll: null,
      homeworks: [{ id: 77, text: "Workbook p. 12", dueDateTime: "2026-11-20T08:00", completed: false }],
      teachingContentFiles: [{ id: 1, name: "Sonnberg_Arbeitsblatt.pdf", url: "https://files.example.com/a.pdf" }],
      students: [{ displayName: "Quast Leonhard" }],
      notesStaff: "intern: Leonhard Quast fehlt oft",
    },
  ],
};

export const homeworksLegacy = {
  data: {
    homeworks: [
      {
        id: 801,
        lessonId: 401,
        date: 20261117,
        dueDate: 20261120,
        text: "Aufgabe 4 – bei Fragen an Frau Petra Okafor",
        remark: "",
        completed: false,
        attachments: [{ id: 5, name: "Mia_Blatt.pdf", url: "/WebUntis/api/homeworks/file/5" }],
      },
      { id: 802, lessonId: 402, date: 20261110, dueDate: 20261112, text: "Gedicht lernen", remark: "", completed: true, attachments: [] },
    ],
    lessons: [
      { id: 401, subject: "Deutsch", lessonType: "Unterricht" },
      { id: 402, subject: "Englisch", lessonType: "Unterricht" },
    ],
    records: [
      { homeworkId: 801, teacherId: 13, elementIds: [] },
      { homeworkId: 802, teacherId: 13, elementIds: [] },
    ],
    teachers: [{ id: 13, name: "Okafor Petra" }],
  },
};

export const exams2017 = {
  type: "STUDENT",
  id: SELF.id,
  exams: [
    {
      id: 601,
      examType: "Klausur",
      startDateTime: "2026-11-25T08:00+01:00",
      endDateTime: "2026-11-25T09:30+01:00",
      subjectId: 301,
      klasseIds: [70],
      roomIds: [201],
      teacherIds: [11],
      invigilators: [{ id: 11, startTime: "0800", endTime: "0930" }],
      name: "Klausur Nr. 2",
      text: "",
    },
  ],
};

export const absences2017 = {
  absences: [
    {
      id: 701,
      studentId: SELF.id,
      klasseId: 70,
      startDateTime: "2026-10-05T08:00",
      endDateTime: "2026-10-05T13:00",
      owner: true,
      excused: true,
      excuse: { id: 1, excuseStatusId: 1, text: "Attest liegt vor, Mia Sonnberg hat es abgegeben", number: 1, date: "2026-10-07" },
      absenceReasonId: 1,
      absenceReason: "Krankheit",
      text: "",
    },
    {
      id: 702,
      studentId: SELF.id,
      klasseId: 70,
      startDateTime: "2026-11-02T09:50",
      endDateTime: "2026-11-02T10:35",
      owner: true,
      excused: false,
      excuse: null,
      absenceReasonId: 1,
      absenceReason: "Krankheit",
      text: "",
    },
  ],
};

export const messages = {
  incomingMessages: [
    {
      id: 1001,
      subject: "Elternabend 7b",
      contentPreview: "Liebe Eltern, … Ihr Hans Müller",
      sender: { userId: 9100, displayName: "Müller Hans" },
      sentDateTime: "2026-11-17T18:00:00",
      isMessageRead: false,
      hasAttachments: true,
      requestConfirmation: null,
    },
    {
      id: 1002,
      subject: "Fundsache",
      contentPreview: "Hallo, hier ist Ottilie Brennecke",
      sender: { userId: 9200, displayName: "Ottilie Brennecke", role: "PARENT" },
      sentDateTime: "2026-11-16T10:00:00",
      isMessageRead: true,
      hasAttachments: false,
    },
  ],
  readConfirmationMessages: [],
};

export const messageDetail = {
  ...messages.incomingMessages[0],
  content:
    "<p>Liebe Eltern,</p><p>der Elternabend ist am 26.11. Rückfragen an hans.mueller@schule.example oder 0421 1234567.</p><p>Ihr Hans Müller</p>",
  storageAttachments: [{ id: "abc-key", name: "Einladung Hans Müller.pdf" }],
  recipients: [{ displayName: "Eltern 7b" }],
};

export const newsWidget = {
  data: {
    systemMessage: null,
    messagesOfDay: [{ id: 1, subject: "Hitzefrei", text: "<b>Ab 12 Uhr</b> frei – Info von Sabine Lindqvist", attachments: [] }],
    rssUrl: "NewsFeed.do?school=example",
  },
};

export type FakeOverrides = Partial<Record<keyof UntisApi, unknown>>;

export function fakeApi(overrides: FakeOverrides = {}): UntisApi {
  const api: UntisApi = {
    hasIntern: true,
    login: async () => loginResult,
    masterFromRpc: async () => {
      throw new Error("not used");
    },
    userData: async () => loginResult,
    ownClassId: async () => 70,
    students: async () => STUDENTS,
    teachers: async () => TEACHERS.map((t) => ({ id: t.id, name: t.name, foreName: t.firstName, longName: t.lastName })),
    myTimetableResource: async () => SELF.id,
    timetableEntries: async (start: string, end: string) => ({
      ...timetableEntries,
      days: timetableEntries.days.filter((d) => d.date >= start && d.date <= end),
    }),
    rpcTimetable: async () => [],
    calendarDetail: async () => calendarDetail,
    homeworksLegacy: async () => homeworksLegacy,
    homework2017: async () => ({ homeWorks: [], lessonsById: {} }),
    exams2017: async () => exams2017,
    examsLegacy: async () => ({ data: { exams: [] } }),
    absences2017: async () => absences2017,
    absencesLegacy: async () => ({ data: { absences: [] } }),
    messages: async () => messages,
    unreadMessages: async () => 1,
    message: async () => messageDetail,
    attachmentStorageUrl: async () => "https://bucket.s3.amazonaws.com/x?X-Amz-Signature=secret",
    messagesOfDay: async () => newsWidget,
    download: async () => ({
      data: new TextEncoder().encode("Einladung von Hans Müller für Jonas Beispielmann"),
      contentType: "text/plain",
      disposition: null,
    }),
  } as UntisApi;
  return Object.assign(api, overrides);
}

export function fakeContext(
  overrides: FakeOverrides = {},
  opts: { redactTeachers?: boolean; absenceTexts?: "redact" | "drop"; lang?: "de" | "en" } = {},
) {
  const untis = fakeApi(overrides);
  const people = new PersonRegistry({
    secret: "test-secret-0123456789",
    scope: "https://example.webuntis.com|example",
    labels: LABELS[opts.lang ?? "de"],
    redactTeachers: opts.redactTeachers,
    directory: new TeacherDirectory(null),
  });
  const files = new FileService((p, max) => untis.download(p, max), { maxBytes: 10_000_000 });
  return createContext({
    cfg: { timezone: "Europe/Berlin", maxRangeDays: 31, absenceTexts: opts.absenceTexts ?? "redact", maxFileMb: 10 },
    untis,
    redactor: new Redactor(people),
    files,
    now: () => NOW,
  });
}

export async function readyContext(overrides: FakeOverrides = {}, opts: Parameters<typeof fakeContext>[1] = {}) {
  const ctx = fakeContext(overrides, opts);
  await ctx.ensureReady();
  return ctx;
}

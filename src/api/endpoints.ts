/**
 * Typed WebUntis endpoints (choice of endpoints: docs/mcp-server-spec.md, section 2).
 * Read-only: GET requests and an allowlist of JSON-RPC read methods.
 */
import type { UntisSession } from "../auth/session";
import { MasterIndex } from "../masterdata";
import { TtlCache } from "./cache";
import type {
  Absences2017,
  CalendarDetail,
  Exams2017,
  Homework2017,
  LegacyAbsences,
  LegacyExams,
  LegacyHomeworks,
  MessageDetail,
  MessageList,
  NewsWidget,
  RpcPeriod,
  RpcStudent,
  RpcTeacher,
  TimetableEntries,
  TimetableFilter,
  UserData2017,
} from "./types";

const MASTER_TTL_MS = 15 * 60_000;

/** "2026-11-18" → 20261118 */
export const untisDate = (iso: string) => Number(iso.replace(/-/g, ""));

export class Untis {
  private cache: TtlCache;

  constructor(
    readonly session: UntisSession,
    private listTtlMs = 60_000,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(now);
  }

  get hasIntern() {
    return this.session.hasIntern;
  }

  /** Logs in (if needed) and returns the raw login result (getUserData2017 or authenticate). */
  async login(): Promise<unknown> {
    await this.session.ensureLogin();
    return this.session.loginResult;
  }

  /** Master data for password logins (JSON-RPC). */
  masterFromRpc() {
    return MasterIndex.fromRpc(this.session);
  }

  private list<T>(key: string, load: () => Promise<T>) {
    return this.cache.get(key, this.listTtlMs, load);
  }

  private master<T>(key: string, load: () => Promise<T>) {
    return this.cache.get(key, MASTER_TTL_MS, load);
  }

  clearCache() {
    this.cache.clear();
  }

  // ---------- User / master data ----------

  /** getUserData2017: user + master data (app secret login only). */
  userData(): Promise<UserData2017> {
    return this.master("userData", () =>
      this.session.intern<UserData2017>("getUserData2017", { elementId: 0, deviceOs: "AND", deviceOsVersion: "" }),
    );
  }

  /** The own class (userData.klassenIds is empty for students). */
  ownClassId(): Promise<number | undefined> {
    return this.master("daytimetableConfig", async () => {
      const r = await this.session.legacy<{ data?: { klasseId?: number } }>("/api/daytimetable/config");
      const id = r.data?.klasseId;
      return typeof id === "number" && id > 0 ? id : undefined;
    });
  }

  students(): Promise<RpcStudent[]> {
    return this.master("students", () => this.session.rpc<RpcStudent[]>("getStudents"));
  }

  teachers(): Promise<RpcTeacher[]> {
    return this.master("teachers", () => this.session.rpc<RpcTeacher[]>("getTeachers"));
  }

  latestImportTime(): Promise<number> {
    return this.session.rpc<number>("getLatestImportTime");
  }

  // ---------- Timetable ----------

  /** Own timetable resource of the REST view API. */
  myTimetableResource(): Promise<number | undefined> {
    return this.master("ttFilter", async () => {
      const f = await this.session.rest<TimetableFilter>(
        "/api/rest/view/v1/timetable/filter?resourceType=STUDENT&timetableType=MY_TIMETABLE",
      );
      return f.preSelected?.id ?? undefined;
    });
  }

  timetableEntries(start: string, end: string, resourceId: number): Promise<TimetableEntries> {
    const q = new URLSearchParams({
      start,
      end,
      format: "1",
      resourceType: "STUDENT",
      resources: String(resourceId),
      timetableType: "MY_TIMETABLE",
      layout: "START_TIME",
    });
    return this.list(`tt:${start}:${end}:${resourceId}`, () =>
      this.session.rest<TimetableEntries>(`/api/rest/view/v1/timetable/entries?${q}`),
    );
  }

  /** Fallback: documented JSON-RPC timetable. */
  rpcTimetable(elementId: number, start: string, end: string): Promise<RpcPeriod[]> {
    return this.list(`rpcTt:${elementId}:${start}:${end}`, () =>
      this.session.rpc<RpcPeriod[]>("getTimetable", {
        options: {
          element: { id: elementId, type: 5 },
          startDate: untisDate(start),
          endDate: untisDate(end),
          showInfo: true,
          showSubstText: true,
          showLsText: true,
          showStudentgroup: true,
          klasseFields: ["id", "name", "longname"],
          teacherFields: ["id", "name", "longname"],
          subjectFields: ["id", "name", "longname"],
          roomFields: ["id", "name", "longname"],
        },
      }),
    );
  }

  calendarDetail(elementId: number, startDateTime: string, endDateTime: string): Promise<CalendarDetail> {
    const q = new URLSearchParams({
      elementId: String(elementId),
      elementType: "5",
      startDateTime,
      endDateTime,
      homeworkOption: "DUE",
    });
    return this.list(`cal:${elementId}:${startDateTime}:${endDateTime}`, () =>
      this.session.rest<CalendarDetail>(`/api/rest/view/v2/calendar-entry/detail?${q}`),
    );
  }

  // ---------- Homework / exams / absences ----------

  homeworksLegacy(start: string, end: string): Promise<LegacyHomeworks> {
    return this.list(`hw:${start}:${end}`, () =>
      this.session.legacy<LegacyHomeworks>(`/api/homeworks/lessons?startDate=${untisDate(start)}&endDate=${untisDate(end)}`),
    );
  }

  homework2017(elementId: number, start: string, end: string): Promise<Homework2017> {
    return this.list(`hw17:${elementId}:${start}:${end}`, () =>
      this.session.intern<Homework2017>("getHomeWork2017", { id: elementId, type: "STUDENT", startDate: start, endDate: end }),
    );
  }

  exams2017(elementId: number, start: string, end: string): Promise<Exams2017> {
    return this.list(`ex17:${elementId}:${start}:${end}`, () =>
      this.session.intern<Exams2017>("getExams2017", { id: elementId, type: "STUDENT", startDate: start, endDate: end }),
    );
  }

  /** Legacy exams – the response lists all participants; only allowlisted fields are ever mapped. */
  examsLegacy(classId: number | undefined, start: string, end: string): Promise<LegacyExams> {
    return this.list(`ex:${classId}:${start}:${end}`, () =>
      this.session.legacy<LegacyExams>(
        `/api/exams?startDate=${untisDate(start)}&endDate=${untisDate(end)}&klasseId=${classId ?? -1}&withGrades=false`,
      ),
    );
  }

  absences2017(start: string, end: string): Promise<Absences2017> {
    return this.list(`abs17:${start}:${end}`, () =>
      this.session.intern<Absences2017>("getStudentAbsences2017", {
        startDate: start,
        endDate: end,
        includeExcused: true,
        includeUnExcused: true,
      }),
    );
  }

  absencesLegacy(studentId: number, start: string, end: string): Promise<LegacyAbsences> {
    return this.list(`abs:${studentId}:${start}:${end}`, () =>
      this.session.legacy<LegacyAbsences>(
        `/api/classreg/absences/students?startDate=${untisDate(start)}&endDate=${untisDate(end)}&studentId=${studentId}&excuseStatusId=-1`,
      ),
    );
  }

  // ---------- Messages ----------

  messages(search?: string): Promise<MessageList> {
    const q = search ? `?searchText=${encodeURIComponent(search)}` : "";
    return this.list(`msgs:${search ?? ""}`, () => this.session.rest<MessageList>(`/api/rest/view/v1/messages${q}`));
  }

  unreadMessages(): Promise<number> {
    return this.list(
      "msgStatus",
      async () => (await this.session.rest<{ unreadMessagesCount?: number }>("/api/rest/view/v1/messages/status")).unreadMessagesCount ?? 0,
    );
  }

  message(id: number): Promise<MessageDetail> {
    return this.list(`msg:${id}`, () => this.session.rest<MessageDetail>(`/api/rest/view/v1/messages/${id}?contentAsHtml=true`));
  }

  /** Signed storage URL of a message attachment (secret – stays inside the FileService). */
  async attachmentStorageUrl(storageClientKey: string): Promise<string | undefined> {
    const r = await this.session.rest<{ downloadUrl?: string; url?: string } | string>(
      `/api/rest/view/v1/messages/${encodeURIComponent(storageClientKey)}/attachmentstorageurl`,
    );
    if (typeof r === "string") return r;
    return r.downloadUrl ?? r.url;
  }

  messagesOfDay(date: string): Promise<NewsWidget> {
    return this.list(`motd:${date}`, () => this.session.legacy<NewsWidget>(`/api/public/news/newsWidgetData?date=${untisDate(date)}`));
  }

  download(pathOrUrl: string, maxBytes: number) {
    return this.session.download(pathOrUrl, maxBytes);
  }
}

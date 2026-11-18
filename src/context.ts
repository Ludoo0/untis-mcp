import type { Untis } from "./api/endpoints";
import type { Config } from "./config";
import { nowTimeIn, todayIn } from "./dates";
import { ToolError } from "./errors";
import type { FileService } from "./files/service";
import { log } from "./log";
import { MasterIndex } from "./masterdata";
import type { Redactor } from "./redaction/redactor";

/** The parts of the API used by tools (an interface so tests can plug in fakes). */
export type UntisApi = Pick<
  Untis,
  | "hasIntern"
  | "login"
  | "masterFromRpc"
  | "userData"
  | "ownClassId"
  | "students"
  | "teachers"
  | "myTimetableResource"
  | "timetableEntries"
  | "rpcTimetable"
  | "calendarDetail"
  | "homeworksLegacy"
  | "homework2017"
  | "exams2017"
  | "examsLegacy"
  | "absences2017"
  | "absencesLegacy"
  | "messages"
  | "unreadMessages"
  | "message"
  | "attachmentStorageUrl"
  | "messagesOfDay"
  | "download"
>;

export type Me = { studentId: number; classId?: number };

export type AppContext = {
  cfg: Pick<Config, "timezone" | "maxRangeDays" | "absenceTexts" | "downloadDir" | "maxFileMb">;
  untis: UntisApi;
  redactor: Redactor;
  files: FileService;
  /** Login, master data and name dictionary (prerequisite for every tool). */
  ensureReady(): Promise<void>;
  me(): Me;
  master(): MasterIndex;
  now(): Date;
  today(): string;
  nowTime(): string;
};

const MASTER_MAX_AGE_MS = 15 * 60_000;

type LoginShape = {
  userData?: { elemType?: string; elemId?: number; displayName?: string };
  masterData?: Parameters<typeof MasterIndex.fromMasterData>[0];
  personType?: number;
  personId?: number;
  klasseId?: number;
};

export function createContext(opts: {
  cfg: AppContext["cfg"];
  untis: UntisApi;
  redactor: Redactor;
  files: FileService;
  now?: () => Date;
}): AppContext {
  const { untis, redactor } = opts;
  const people = redactor.people;
  const now = opts.now ?? (() => new Date());
  let ready: Promise<void> | undefined;
  let me: Me | undefined;
  let master = new MasterIndex();
  let refreshing = false;

  const registerTeachers = (m: MasterIndex) =>
    people.addTeachers(m.teachers.map((t) => ({ id: t.id, abbreviation: t.name, firstName: t.firstName, lastName: t.lastName })));

  const init = async () => {
    const lr = ((await untis.login()) ?? {}) as LoginShape;
    let studentId: number | undefined;
    let classId: number | undefined;
    if (untis.hasIntern) {
      if (lr.userData?.elemType && lr.userData.elemType !== "STUDENT") {
        throw new ToolError("NO_RIGHT", "Only student accounts are supported (this account is not a student account).", undefined, true);
      }
      studentId = lr.userData?.elemId;
      master = MasterIndex.fromMasterData(lr.masterData);
    } else {
      if (lr.personType !== undefined && lr.personType !== 5) {
        throw new ToolError("NO_RIGHT", "Only student accounts are supported (this account is not a student account).", undefined, true);
      }
      studentId = lr.personId;
      classId = lr.klasseId;
      master = await untis.masterFromRpc();
    }
    if (typeof studentId !== "number") throw new ToolError("UPSTREAM_ERROR", "WebUntis did not return the own student id.");
    people.setSelf(studentId, { displayName: lr.userData?.displayName });
    registerTeachers(master);

    // Teacher names from JSON-RPC (first names – so they can be removed from free text)
    if (untis.hasIntern) {
      try {
        people.addTeachers(
          (await untis.teachers()).map((t) => ({ id: t.id, abbreviation: t.name, firstName: t.foreName, lastName: t.longName })),
        );
      } catch {
        log.warn("Teacher list not available (getTeachers)");
      }
    }
    // All students of the school for the name dictionary (memory only)
    try {
      const students = await untis.students();
      people.addStudents(students.map((s) => ({ id: s.id, firstName: s.foreName, lastName: s.longName })));
      const self = students.find((s) => s.id === studentId);
      if (self) people.setSelf(studentId, { firstName: self.foreName, lastName: self.longName });
    } catch {
      log.warn("Student list not available (getStudents) – classmates' names in free text may not be detected");
    }
    if (classId === undefined) classId = await untis.ownClassId().catch(() => undefined);
    me = { studentId, ...(classId !== undefined ? { classId } : {}) };
    log.info("Ready", { teachers: people.teacherCount, students: people.studentCount, subjects: master.subjects.size });
  };

  const refreshMaster = () => {
    if (refreshing || !untis.hasIntern || Date.now() - master.loadedAt < MASTER_MAX_AGE_MS) return;
    refreshing = true;
    untis
      .userData()
      .then((ud) => {
        if (ud.masterData) {
          master = MasterIndex.fromMasterData(ud.masterData);
          registerTeachers(master);
        }
      })
      .catch(() => log.warn("Master data refresh failed"))
      .finally(() => {
        refreshing = false;
      });
  };

  return {
    cfg: opts.cfg,
    untis,
    redactor,
    files: opts.files,
    now,
    today: () => todayIn(opts.cfg.timezone, now()),
    nowTime: () => nowTimeIn(opts.cfg.timezone, now()),
    async ensureReady() {
      ready ??= init().catch((e) => {
        if (!(e instanceof ToolError && e.fatal)) ready = undefined; // non-fatal: retry on the next call
        throw e;
      });
      await ready;
      refreshMaster();
    },
    me() {
      if (!me) throw new ToolError("INTERNAL", "Not initialised.");
      return me;
    },
    master: () => master,
  };
}

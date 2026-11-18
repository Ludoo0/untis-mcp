/**
 * Raw WebUntis response shapes (only the fields the server reads – docs/untis-api.md).
 * Everything is optional: WebUntis omits empty fields and the API is undocumented.
 */

// ---------- getUserData2017 ----------

export type MdNamed = { id: number; name?: string; longName?: string; active?: boolean };
export type MdTeacher = { id: number; name?: string; firstName?: string; lastName?: string; active?: boolean };
export type MdHoliday = { id: number; name?: string; longName?: string; startDate?: string; endDate?: string };
export type MdSchoolyear = { id: number; name?: string; startDate?: string; endDate?: string };
export type MdExcuseStatus = { id: number; name?: string; longName?: string; excused?: boolean };
export type MdTimeGrid = { days?: { day?: string; units?: { label?: string; startTime?: string; endTime?: string }[] }[] };

export type MasterData = {
  timeStamp?: number;
  absenceReasons?: MdNamed[];
  excuseStatuses?: MdExcuseStatus[];
  holidays?: MdHoliday[];
  klassen?: MdNamed[];
  rooms?: MdNamed[];
  subjects?: MdNamed[];
  teachers?: MdTeacher[];
  schoolyears?: MdSchoolyear[];
  timeGrid?: MdTimeGrid;
};

export type UserData2017 = {
  masterData?: MasterData;
  userData?: { elemType?: string; elemId?: number; displayName?: string; klassenIds?: number[]; rights?: string[] };
  settings?: { showAbsenceReason?: boolean; showAbsenceText?: boolean };
};

// ---------- JSON-RPC ----------

export type RpcStudent = { id: number; key?: string; name?: string; foreName?: string; longName?: string };
export type RpcTeacher = { id: number; name?: string; foreName?: string; longName?: string };

export type RpcPeriodElement = { id: number; name?: string; longname?: string; orgid?: number; orgname?: string };
export type RpcPeriod = {
  id: number;
  date: number;
  startTime: number;
  endTime: number;
  kl?: RpcPeriodElement[];
  te?: RpcPeriodElement[];
  su?: RpcPeriodElement[];
  ro?: RpcPeriodElement[];
  lstype?: string;
  code?: string;
  lstext?: string;
  info?: string;
  substText?: string;
  activityType?: string;
  sg?: string;
};

// ---------- REST view: timetable ----------

export type RestResource = { id?: number; shortName?: string; longName?: string; displayName?: string };

export type GridPositionItem = {
  current?: { type?: string; status?: string; shortName?: string; longName?: string; displayName?: string } | null;
  removed?: { type?: string; status?: string; shortName?: string; longName?: string; displayName?: string } | null;
};

export type GridEntry = {
  ids?: number[];
  duration?: { start?: string; end?: string };
  type?: string;
  status?: string;
  statusDetail?: string | null;
  name?: string | null;
  notesAll?: string | null;
  icons?: string[];
  texts?: { type?: string; text?: string }[];
  lessonText?: string | null;
  lessonInfo?: string | null;
  substitutionText?: string | null;
  moved?: unknown;
  position1?: GridPositionItem[] | null;
  position2?: GridPositionItem[] | null;
  position3?: GridPositionItem[] | null;
  position4?: GridPositionItem[] | null;
  position5?: GridPositionItem[] | null;
  position6?: GridPositionItem[] | null;
  position7?: GridPositionItem[] | null;
};

export type TimetableDay = {
  date?: string;
  status?: string;
  gridEntries?: GridEntry[];
  dayEntries?: { type?: string; status?: string; name?: string; duration?: { start?: string; end?: string } }[];
  backEntries?: { type?: string; name?: string; duration?: { start?: string; end?: string } }[];
};

export type TimetableEntries = { days?: TimetableDay[]; errors?: unknown[] };
export type TimetableFilter = { preSelected?: RestResource | null };

export type CalendarRes = { id?: number; shortName?: string; longName?: string; displayName?: string; status?: string };
export type CalendarFile = {
  id?: number | string;
  name?: string;
  fileName?: string;
  src?: string;
  url?: string;
  storageClientKey?: string;
};
export type CalendarEntry = {
  id?: number;
  startDateTime?: string;
  endDateTime?: string;
  status?: string;
  type?: string;
  subType?: { displayName?: string } | null;
  subject?: CalendarRes | null;
  klasses?: CalendarRes[];
  teachers?: CalendarRes[];
  rooms?: CalendarRes[];
  teachingContent?: string | null;
  teachingContentFiles?: CalendarFile[];
  notesAll?: string | null;
  notesAllFiles?: CalendarFile[];
  lessonInfo?: string | null;
  substText?: string | null;
  homeworks?: { id?: number; text?: string; remark?: string; dateTime?: string; dueDateTime?: string; completed?: boolean }[];
  exam?: { name?: string; text?: string; examType?: string } | null;
  mainStudentGroup?: { name?: string } | null;
};
export type CalendarDetail = { calendarEntries?: CalendarEntry[] };

// ---------- Legacy homework ----------

export type LegacyAttachment = { id?: number | string; name?: string; url?: string };
export type LegacyHomework = {
  id: number;
  lessonId?: number;
  date?: number;
  dueDate?: number;
  text?: string;
  remark?: string;
  completed?: boolean;
  attachments?: LegacyAttachment[];
};
export type LegacyHomeworks = {
  data?: {
    homeworks?: LegacyHomework[];
    lessons?: { id: number; subject?: string; lessonType?: string }[];
    records?: { homeworkId?: number; teacherId?: number; elementIds?: number[] }[];
    teachers?: { id: number; name?: string }[];
  };
};

// ---------- Intern ----------

export type Homework2017 = {
  homeWorks?: {
    id: number;
    lessonId?: number;
    startDate?: string;
    endDate?: string;
    text?: string;
    remark?: string | null;
    completed?: boolean;
    attachments?: LegacyAttachment[];
  }[];
  lessonsById?: Record<string, { id: number; subjectId?: number; teacherIds?: number[] }>;
};

export type Exam2017 = {
  id: number;
  examType?: string;
  startDateTime?: string;
  endDateTime?: string;
  subjectId?: number;
  klasseIds?: number[];
  roomIds?: number[];
  teacherIds?: number[];
  name?: string;
  text?: string;
};
export type Exams2017 = { exams?: Exam2017[] };

/** Only the fields that may be mapped – assignedStudents etc. are deliberately not typed. */
export type LegacyExams = {
  data?: {
    exams?: {
      id: number;
      examType?: string;
      name?: string;
      examDate?: number;
      startTime?: number;
      endTime?: number;
      subject?: string;
      teachers?: string[];
      rooms?: string[];
      text?: string;
    }[];
  };
};

export type Absence2017 = {
  id: number;
  startDateTime?: string;
  endDateTime?: string;
  excused?: boolean;
  excuse?: { excuseStatusId?: number; text?: string } | null;
  absenceReasonId?: number;
  absenceReason?: string;
  text?: string;
};
export type Absences2017 = { absences?: Absence2017[] };

export type LegacyAbsence = {
  id: number;
  startDate?: number;
  endDate?: number;
  startTime?: number;
  endTime?: number;
  reason?: string;
  text?: string;
  excuseStatus?: string;
  isExcused?: boolean;
};
export type LegacyAbsences = { data?: { absences?: LegacyAbsence[] } };

// ---------- Messages ----------

export type MessageSender = { userId?: number; displayName?: string; className?: string; role?: string; imageUrl?: string };
export type MessageAttachment = { id?: string | number; name?: string; storageClientKey?: string; src?: string };
export type MessageListItem = {
  id: number;
  subject?: string;
  contentPreview?: string;
  sender?: MessageSender;
  sentDateTime?: string;
  isMessageRead?: boolean;
  hasAttachments?: boolean;
  requestConfirmation?: { confirmationDate?: string | null } | boolean | null;
};
export type MessageList = { incomingMessages?: MessageListItem[]; readConfirmationMessages?: MessageListItem[] };
export type MessageDetail = MessageListItem & {
  content?: string;
  storageAttachments?: MessageAttachment[];
  attachments?: MessageAttachment[];
  blobAttachment?: MessageAttachment | null;
  recipients?: { displayName?: string; className?: string; role?: string }[];
};

// ---------- Messages of the day ----------

export type MessageOfDay = { id?: number; subject?: string; text?: string; attachments?: LegacyAttachment[] };
export type NewsWidget = { data?: { messagesOfDay?: MessageOfDay[] } };

# WebUntis API – findings for the MCP server

As of 2026-11-18 · Reference instance: a school on `https://<school>.webuntis.com` (WebUntis 2027.4.2)
Sources: unauthenticated checks against the reference instance, analysis of the generated OpenAPI client in the WebUntis web app bundle (`/assets/index-*.js`), the official JSON-RPC API documentation by Untis, community clients (e.g. the `webuntis` npm package), and **one probe run with a student account** (SSO account, login via the Untis Mobile app secret; `scripts/dev/probe.ts`, window ±14 days).

> This document deliberately contains no content, names or IDs from any account – only structures.
> Specification of the server built on top of it: [`mcp-server-spec.md`](./mcp-server-spec.md)

Legend: ✅ verified with the student account · 🌐 verified without login · 📦 only known from the web app bundle (path, method, parameters, enums) · ⏳ not yet verified (e.g. no test data)

## TL;DR

| Use case | Feasible? | Recommended endpoint | Alternatives |
|---|---|---|---|
| Login with an SSO account | ✅ | Untis Mobile app secret (QR code) + TOTP → `jsonrpc_intern.do getUserData2017` → `JSESSIONID` | password `authenticate` (native accounts only) |
| Timetable incl. changes | ✅ | `GET /api/rest/view/v1/timetable/entries` | JSON-RPC `getTimetable` ✅, `getTimetable2017` ✅, legacy `weekly/data` ✅ |
| Lesson details (topic, notes) | ✅ | `GET /api/rest/view/v2/calendar-entry/detail` | – |
| Homework | ✅ | legacy `GET /api/homeworks/lessons` | `getHomeWork2017` ✅; REST `classreg/homework/list` ❌ 403 |
| Exams | ✅ | `getExams2017` (IDs only, no student lists) | REST `GET /api/rest/view/v1/exams` ✅, legacy `GET /api/exams` ✅ (both with student lists!); JSON-RPC `getExams` ❌ `-8509` |
| Own absences | ✅ | `getStudentAbsences2017` | legacy `GET /api/classreg/absences/students` ✅; REST `classreg/absences` returns an empty list ⏳ |
| Messages (inbox) | ✅ (empty) | `GET /api/rest/view/v1/messages`, `messages/status` | – |
| Messages of the day | 🌐 ✅ (empty) | `GET /api/public/news/newsWidgetData?date=YYYYMMDD` (public!) | `getMessagesOfDay2017` ✅ |
| Master data | ✅ | `getUserData2017.masterData` | JSON-RPC `getSubjects`/`getRooms`/`getKlassen`/`getHolidays`/`getTimegridUnits`/`getSchoolyears` ✅ |
| Teacher/student directory (for redaction) | ✅ | JSON-RPC `getTeachers`, `getStudents` – **allowed for the student account** | – |
| File downloads | ⏳ | message attachments `messages/{storageClientKey}/attachmentstorageurl` / `messages/{id}/attachment` 📦 | no attachment in the test data |

All paths below are relative to `https://<school>.webuntis.com/WebUntis`, unless noted otherwise.

## General

### School search 🌐

```http
POST https://mobile.webuntis.com/ms/schoolquery2
Content-Type: application/json

{"id":"1","jsonrpc":"2.0","method":"searchSchool","params":[{"search":"<text>"}]}
```

Returns `result.schools[]` with `server` (host, e.g. `<school>.webuntis.com`), `loginName` (the `school` parameter of every API call), `schoolId`, `tenantId`, `displayName`, `address`, `serverUrl`, `mobileServiceUrl`, `useMobileServiceUrlAndroid/Ios`. Public, no auth.

> The web host is `*.webuntis.com`; a host under `*.untis.com` does not resolve for the reference school.

### Hosts and cookies

- 🌐 `GET /WebUntis/` sets cookies `JSESSIONID` (path `/WebUntis`, `HttpOnly`), `schoolname="_<base64(loginName)>"` and `Tenant-Id="<tenantId>"`.
- ✅ After the login the cookie jar holds `schoolname`, `JSESSIONID`, `Tenant-Id`; this is enough for all four API families.
- 🌐 `GET /` serves the new React web app (single bundle `assets/index-<hash>.js`, ~7.7 MB). It contains a generated OpenAPI client for the REST API – the source of the 📦 entries.
- Profile/teacher images come from `https://images.webuntis.com/image/{n}/{token}` (tokenised) – never used.

### Four API families

| Family | Base | Auth | Notes |
|---|---|---|---|
| JSON-RPC (public, documented) | `POST /jsonrpc.do?school=<loginName>` | session cookie | ✅ works with the session from the app secret login. Dates `YYYYMMDD`, times `HHMM` as numbers. |
| JSON-RPC intern (mobile app) | `POST /jsonrpc_intern.do?m=<method>&school=<loginName>&v=i2.2` | `auth: {user, otp, clientTime}` inside the params (TOTP) | ✅ `*2017` methods for user data, timetable, homework, exams, absences, messages of the day. Dates ISO, date-times ISO with offset. References via IDs into `masterData`. |
| Legacy REST | `/api/...` | session cookie | ✅ used by the old web UI. Dates `YYYYMMDD`. Responses `{ data: … }`. |
| REST view API (current web app) | `/api/rest/view/v{1..4}/...` | `Authorization: Bearer <JWT>` from `GET /api/token/new` (+ cookie) | ✅ ISO dates/date-times. Errors as `{errorCode, errorMessage, requestId, traceId}`. Some endpoints are forbidden for students. `/api/v2/...` (period administration) → 404 for students. |

### Element types (JSON-RPC / legacy REST) ✅

| `type` | Element |
|---|---|
| 1 | class (`KLASSE`) |
| 2 | teacher |
| 3 | subject |
| 4 | room |
| 5 | student |
| 12 | parent / legal guardian (`personType` of parent accounts) ⏳ |

Intern API: names (`CLASS`, `TEACHER`, `SUBJECT`, `ROOM`, `STUDENT`). REST view API: `ResourceTypeEnum` (`CLASS`, `ROOM`, `RESOURCE`, `STUDENT`, `SUBJECT`, `TEACHER`).

### Errors

| Where | Value | Meaning |
|---|---|---|
| JSON-RPC | `-8520` | not authenticated 🌐 |
| JSON-RPC | `-8509` | `no right for <method>()` ✅ – for the student account: `getSubstitutions`, `getExamTypes`, `getExams`, `getClassregEvents`, `getTimetableWithAbsences` |
| JSON-RPC | `-8504` | bad credentials ⏳ |
| JSON-RPC | `-7004` | date outside the allowed range ⏳ |
| JSON-RPC | HTTP status | always `200`, the error is only in the body ✅ |
| REST | `403 {"errorCode":"FORBIDDEN","errorMessage":"Access Denied"}` | ✅ `classreg/homework/meta`, `classreg/homework/list` for students |
| REST | `403 … "no right for anonymous user"` | 🌐 anonymous timetable |
| REST | `404 {"errorCode":"NOT_FOUND"}` | 🌐 also returned **without auth** for existing endpoints – a 404 does not prove that an endpoint is missing; ✅ `api/v2/periods/day-states` for students |
| REST | `500 {"errorCode":"INTERNAL_ERROR"}` | 🌐 `GET rest/view/v1/session/status` (the web app uses POST) |
| Legacy REST | `302` to the login page | 🌐 `api/token/new`, `api/session/status` without session |

Error texts may contain IDs → only log them sanitised.

## Authentication

### Login options of the instance 🌐

The legacy page config (`GET /WebUntis/?school=<loginName>`, also in `GET /api/app/config` after login) contains `loginServiceConfig`. Reference instance:

| Field | Value | Meaning |
|---|---|---|
| `ssoOidc` | `true` | OpenID Connect login via the state's school portal (label `oidcProviderLabel`, a UCS portal) |
| `hideWuLogin` | `false` | the native WebUntis login form is still offered |
| `ssoOffice365` | `false` | – |
| `ssoSamlProviders` | `[]` | no SAML |

Students of the reference school log in via the **UCS portal (OIDC)** and usually have no native WebUntis password. A headless OIDC login is **not supported**.

### Path 1: Untis Mobile app secret (TOTP) ✅

WebUntis shows a QR code for the mobile app under *Profile → Sharing ("Freigaben") → Untis Mobile* – ✅ also for the SSO student account of the reference school. It encodes:

```
untis://setschool?url=<school>.webuntis.com&school=<loginName>&user=<username>&key=<SECRET>&schoolNumber=<n>
```

`key` is a Base32 secret. Every internal API call authenticates with a TOTP derived from it (RFC 6238: HMAC-SHA1, 30 s, 6 digits):

```http
POST /WebUntis/jsonrpc_intern.do?m=getUserData2017&school=<loginName>&v=i2.2
Content-Type: application/json

{"id":"1","jsonrpc":"2.0","method":"getUserData2017",
 "params":[{"elementId":0,"deviceOs":"AND","deviceOsVersion":"",
            "auth":{"user":"<username>","otp":"123456","clientTime":1763456789000}}]}
```

✅ Result:
- `masterData` (see master data), `userData{elemType ("STUDENT"), elemId, displayName, schoolName, departmentId, children[], klassenIds[] (empty for the student!), rights[] (e.g. CLASSREGISTER, R_MY_ABSENCES, R_OFFICEHOURS)}`, `settings{showAbsenceReason, showAbsenceText, absenceCheckRequired, defaultAbsenceReasonId, …}`.
- `Set-Cookie: JSESSIONID` – **the session can be used for JSON-RPC, the legacy REST API and `api/token/new`**.
- The own class: `GET /api/daytimetable/config` → `data.klasseId` ✅ (`userData.klassenIds` is empty).

Open: tolerance for clock skew ⏳.

**The secret is equivalent to a password** (permanent access to the account; it changes when the user creates a new QR code). Store it only as a local secret, never in the repository, never log it.

### Path 2: Password (native WebUntis accounts) ⏳

```http
POST /WebUntis/jsonrpc.do?school=<loginName>
{"id":"1","jsonrpc":"2.0","method":"authenticate","params":{"user":"…","password":"…","client":"<client name>"}}
```

→ `result.{sessionId, personType, personId, klasseId}` + `JSESSIONID` cookie. End the session with `logout`. Wrong password → `-8504`. Avoid retry loops (account lockout).

### Session and JWT ✅

- Session = `JSESSIONID`. `GET /api/app/config` contains `data.sessionTimeout` (value not recorded ⏳).
- `GET /api/token/new` (with cookie) → JWT as plain text. **Lifetime 900 s (15 min).** Claims (names only): `tenant_id, sub, roles, iss, locale, sc, user_type, route, user_id, host, sn, scopes, exp, per, iat, username, sr, person_id` → the JWT itself contains personal data and is a secret.
- **Consequences for the server:** there is no refresh token to persist. A new login (TOTP) is cheap and stateless. The server renews the JWT before `exp` and logs in again on `-8520`, a 302 to the login page or a REST `401`.

## Endpoints by use case

### User and master data ✅

| Endpoint | Content |
|---|---|
| `getUserData2017.masterData` | `timeStamp`, `absenceReasons[]{id, name, longName, active}`, `departments[]`, `duties[]{id, name, longName, type}` (types `STEWARD`, `PREFECT`, `CUSTOM`, `PREFECT_SUBST`), `eventReasons[]`, `excuseStatuses[]{id, name, longName, excused}`, `holidays[]{id, name, longName, startDate, endDate}`, `klassen[]{id, name, longName, departmentId, startDate, endDate, active}`, `rooms[]{id, name, longName, …}`, `subjects[]{id, name, longName, foreColor, backColor, …}`, **`teachers[]{id, name (abbreviation), firstName, lastName, departmentIds, exitDate, active}`**, `schoolyears[]{id, name, startDate, endDate}`, `timeGrid.days[]{day, units[]{label, startTime, endTime}}` |
| JSON-RPC `getCurrentSchoolyear`, `getSchoolyears` | `{id, name, startDate, endDate}` |
| JSON-RPC `getSubjects` | `{id, name, longName, alternateName, active, foreColor, backColor}` |
| JSON-RPC `getRooms`, `getKlassen` | `getKlassen`: `{id, name, longName, active, teacher1, teacher2}` (class teacher IDs) |
| JSON-RPC `getTeachers` | ✅ **allowed**: `{id, name (abbreviation), foreName, longName (last name), title, active, dids[]}` |
| JSON-RPC `getStudents` | ✅ **allowed – the whole school**: `{id, key, name, foreName, longName, gender}` |
| JSON-RPC `getHolidays`, `getTimegridUnits`, `getStatusData`, `getLatestImportTime` | holidays, time grid per weekday, colours, timestamp of the last import |
| REST `GET rest/view/v1/app/data` | `currentSchoolYear{id, name, dateRange, timeGrid}`, `tenant{id, name, displayName}`, `user{id, name, email, locale, person{id, displayName, imageUrl}, roles (STUDENT), students[], permissions, lastLogin}`, `permissions[]`, `settings[]`, `holidays[]`, `licenceExpiresAt` |
| REST `GET rest/view/v1/today/meta` | `greetingName`, `calendar{canReadOwn, minStart, maxEnd, classes[], students[]}` |
| REST `GET rest/view/v1/schoolyears`, `/timegrid` | school years; `units[]{unitOfDay, startTime, endTime}` |
| REST `GET rest/view/v1/dashboard/cards` | `dashboardCards[]` (empty for the reference account) |
| Legacy `GET /api/app/config` | web UI configuration incl. `loginServiceConfig.user{name, id, personId, persons[]{id, type, displayName, longName, foreName}, email}`, `calendarServiceConfig` (school years, holidays), `sessionTimeout` |

### Timetable ✅

**REST view API (recommended)**

```
GET /api/rest/view/v1/timetable/entries
    ?start=YYYY-MM-DD&end=YYYY-MM-DD&format=1
    &resourceType=STUDENT&resources=<id>
    &timetableType=MY_TIMETABLE&layout=START_TIME
```

- The own resource comes from `GET rest/view/v1/timetable/filter?resourceType=STUDENT&timetableType=MY_TIMETABLE` → `preSelected{id, shortName, longName, displayName}` (the filter also lists the classes with `classTeacher1/2` and the student with an `imageUrl`). `timetable/menu` → `myTimetable{type, resource}`, `availableTimetables[]`.
- Response: `days[]{date, resourceType, resource, status, dayEntries[], gridEntries[], backEntries[]}`, `errors[]`.
- `gridEntries[]`: `ids[]` (period IDs), `duration{start, end}`, `type`, `status`, `statusDetail`, `name`, `color`, `icons[]` (`HOMEWORK`, `NOTES`), `notesAll`, `lessonText`, `lessonInfo`, `substitutionText`, `texts[]{type, text}` (`NOTES_FOR_ALL`, `SUBSTITUTION_TEXT`, `LESSON_INFO`), `position1…position7[]{current, removed}` with `{type (TEACHER, SUBJECT, ROOM, CLASS), status, shortName, longName, displayName, displayNameLabel}`, `moved`, `link`, layout fields.
- **Changes:** observed `status` values `REGULAR`, `CHANGED`, `ADDED`, `REMOVED` (entry and resource level), day status `NO_DATA`. For substitutions `removed` holds the **original** teacher/room and `current` the new one ✅. Grid entry types observed: `NORMAL_TEACHING_PERIOD`, `EXAM`.
- Further enums from the bundle 📦: `GridEntryStatusEnum` (`REGULAR`, `CANCELLED`, `ADDITIONAL`, `CHANGED`), `GridEntryStatusDetailEnum` (`CONFIRMED`, `TENTATIVE`, `SUBSTITUTED`, `MOVED`), `GridEntryTypeEnum` (`… ADDITIONAL_PERIOD, STAND_BY_PERIOD, OFFICE_HOUR, BREAK_SUPERVISION, EVENT, MEETING, PLATFORM_CALENDAR_EVENT, PERSONAL_CALENDAR_EVENT`), `DayDataStatusEnum` (`REGULAR`, `NO_DATA`, `NOT_ALLOWED`, `NOT_ALLOWED_FOR_RESOURCE`), `BackEntryTypeEnum` (`HOLIDAY`, `ABSENCE`, `BLOCKING`). A cancellation was not in the window ⏳.

**Lesson details** ✅ `GET /api/rest/view/v2/calendar-entry/detail?elementId=<id>&elementType=5&startDateTime=<iso>&endDateTime=<iso>&homeworkOption=DUE` → `calendarEntries[]{id, previousId, nextId, startDateTime, endDateTime, status (REGULAR, TAKING_PLACE), type, subType{displayName}, subject, klasses[], teachers[]{shortName, longName, displayName, status, imageUrl}, rooms[]{…, status}, lesson{lessonId, lessonNumber}, mainStudentGroup{name}, **teachingContent** (lesson topic), teachingContentFiles[], homeworks[], exam, notesAll, notesAllFiles[], notesStaff, lessonInfo, substText, originalCalendarEntry, students[], videoCall, permissions[]}`.

**JSON-RPC `getTimetable`** ✅ (with `showInfo`, `showSubstText`, `showLsText`, `showLsNumber`, `showStudentgroup` and `*Fields: ["id","name","longname"]`) → `periods[]{id, date, startTime, endTime, kl[], te[]{id, name, longname, orgid, orgname}, su[], ro[], lsnumber, sg, activityType, info, substText}` (+ `code`, `lstext`, `lstype` if set). `te[].orgid/orgname` = original teacher. Teacher `name` = abbreviation, `longname` = last name.

**Intern `getTimetable2017`** ✅ → `timetable{displayableStartDate, displayableEndDate, periods[]{id, lessonId, startDateTime, endDateTime, colours, text{lesson, substitution, info, attachments[]}, elements[]{type, id, orgId}, can[] (READ_LESSONTOPIC, READ_HOMEWORK, READ_CLASSROLE, READ_PERIODINFO), is[] (REGULAR, …), homeWorks[], exam, isOnlinePeriod, blockHash}}` + a full copy of `masterData`.

**Legacy `GET /api/public/timetable/weekly/data?elementType=5&elementId=<id>&date=YYYY-MM-DD&formatId=<n>`** ✅ (format from `…/weekly/pageconfig?type=5`) → `data.result.data{elementIds[], elementPeriods{<id>: [{id, lessonId, lessonNumber, lessonCode, lessonText, periodText, periodInfo, periodAttachments[], substText, date, startTime, endTime, elements[]{type, id, orgId, missing, state (REGULAR, SUBSTITUTED)}, studentGroup, code, cellState (STANDARD, SUBSTITUTION), is{standard, event, substitution}, roomCapacity, studentCount, debugInfo}]}, elements[]{type, id, name, longName, displayname, …}}`.

**Decision:** the server uses `timetable/entries` (most complete: original + new resource, texts, icons, ISO times, no ID resolving needed). Fallback: JSON-RPC `getTimetable`.

### Homework ✅

- **Legacy (recommended)** `GET /api/homeworks/lessons?startDate=YYYYMMDD&endDate=YYYYMMDD` → `data{homeworks[]{id, lessonId, date, dueDate, text, remark, completed, attachments[]}, lessons[]{id, subject, lessonType}, teachers[]{id, name}, records[]{homeworkId, teacherId, elementIds[]}}`.
- Intern `getHomeWork2017 {id, type, startDate, endDate}` ✅ → `homeWorks[]{id, lessonId, startDate, endDate, text, remark, completed, attachments[]}`, `lessonsById{<id>: {id, subjectId, klassenIds[], teacherIds[]}}`.
- REST view `POST classreg/homework/list` and `GET classreg/homework/meta` → **403 Access Denied** for students ✅.
- Homework is also embedded in `getTimetable2017` periods and in `calendar-entry/detail`.
- Attachments: no test data ⏳.

### Exams ✅

| Endpoint | Content | Privacy |
|---|---|---|
| Intern `getExams2017 {id, type, startDate, endDate}` (recommended) | `exams[]{id, examType ("Klausur"…), startDateTime, endDateTime, departmentId, subjectId, klasseIds[], roomIds[], teacherIds[], invigilators[]{id, startTime, endTime}, name, text}` | IDs only, no student lists |
| REST `GET /api/rest/view/v1/exams?start=YYYY-MM-DD&end=YYYY-MM-DD` | `exams[]{examId, examType{…}, examName, examText, examStart, examEnd, examDuration, subject, classes[], teachers[], studentgroup, rooms[], invigilators[], numStudents, **students[]{id, displayName, shortName, longName, gender, gradeProtection, disadvantageCompensation}**, examBookedUser, examModifiedUser, …}` | ⚠ lists **all participants including the disadvantage-compensation flag** |
| Legacy `GET /api/exams?startDate&endDate&klasseId=-1&withGrades=true` | `data.exams[]{id, examType, name, studentClass[], **assignedStudents[]{id, displayName, gradeProtection, disadvantageCompensation, klasse}**, examDate, startTime, endTime, subject, teachers[], rooms[], text, grade}` | ⚠ same |
| JSON-RPC `getExams`, `getExamTypes` | `-8509` | – |

### Absences (own) ✅

- **Intern (recommended)** `getStudentAbsences2017 {startDate, endDate, includeExcused, includeUnExcused}` → `absences[]{id, studentId, klasseId, startDateTime, endDateTime, owner, excused, excuse{id, excuseStatusId, text, number, date}, absenceReasonId, absenceReason, text, manualNotificationStatus, autoNotificationStatus, studentOfAge}`.
- Legacy `GET /api/classreg/absences/students?startDate&endDate&studentId=<id>&excuseStatusId=-1` → `data.absences[]{id, startDate, endDate, startTime, endTime, createDate, lastUpdate, **createdUser, updatedUser**, reasonId, reason, text, interruptions[], canEdit, **studentName**, excuseStatus (localised text, e.g. "entschuldigt"), isExcused, excuse{id, text, excuseDate, excuseStatus, isExcused, userId, **username**}}`.
- REST `POST rest/view/v{1,3,4}/classreg/absences` with `{startDate, endDate, studentId}` → `200 {absences: [], dateRange, dateRangeType, …}` – **empty although the other APIs return absences** (wrong request DTO ⏳). `GET classreg/absences/meta` ✅ → `reasons[]`, `excuseStatuses[]{id, name, type (OPEN, EXCUSED, NOT_EXCUSED)}`.
- **Absence reasons and texts can be health data** (GDPR Art. 9).

### Messages ("Mitteilungen") ✅ (no messages in the test account)

| Endpoint | Content |
|---|---|
| `GET /api/rest/view/v1/messages[?searchText=]` | ✅ `{incomingMessages[], readConfirmationMessages[]}` – both empty; entry schema ⏳ (expected: `id, subject, contentPreview, sender{userId, displayName, imageUrl, className}, sentDateTime, isMessageRead, hasAttachments, requestConfirmation`) |
| `GET /api/rest/view/v1/messages/status` | ✅ `{unreadMessagesCount}` |
| `GET /api/rest/view/v1/messages/permissions` | ✅ `{recipientOptions[], allowRequestReadConfirmation, showSentTab, showDraftsTab, maxFileSize, maxFileCount, …}` |
| `GET /api/rest/view/v1/messages/sent` | ✅ (empty) |
| `GET /api/rest/view/v1/messages/{id}?contentAsHtml=true` | 📦 message incl. content and attachments ⏳ |
| `GET /api/rest/view/v1/messages/{id}/attachment`, `…/{storageClientKey}/attachmentstorageurl` | 📦 attachments ⏳ |

⚠ Never called: `POST /messages/{id}/read-confirmation`, `/read`, `/reply`, `DELETE`. Whether `GET messages/{id}` marks a message as read is open ⏳.

### Messages of the day 🌐 ✅

`GET /api/public/news/newsWidgetData?date=YYYYMMDD` → `{data:{systemMessage, messagesOfDay[], rssUrl}}` – **public without login** and the same with a session. Intern: `getMessagesOfDay2017 {date}` → `messages[]`. Both empty at test time; entry schema ⏳.

### Downloading files ⏳

- Message attachments: `messages/{id}/attachment` (blob) or `messages/{storageClientKey}/attachmentstorageurl` → signed storage URL 📦.
- Homework attachments: `attachments[]` in legacy/intern homework; lesson files: `teachingContentFiles[]`, `notesAllFiles[]` in `calendar-entry/detail`; `text.attachments[]` in `getTimetable2017`; `periodAttachments[]` in the legacy timetable. All empty in the test window.

## Not available for students

| Endpoint | Status |
|---|---|
| JSON-RPC `getSubstitutions`, `getExamTypes`, `getExams`, `getClassregEvents`, `getTimetableWithAbsences` | `-8509` ✅ |
| REST `classreg/homework/list`, `classreg/homework/meta` | 403 ✅ |
| REST `api/v2/periods/day-states` | 404 ✅ |
| anonymous timetable | 403 🌐 |
| headless OIDC/UCS login | out of scope |
| everything that writes (`POST/PUT/PATCH/DELETE` except list queries) | not used |

## Personal data & redaction

### Where personal data appears ✅

| Source | Fields |
|---|---|
| Login / user | `userData.displayName`, `elemId`, `schoolName`; `app/data.user{name, email, person{displayName, imageUrl}}`; `today/meta.greetingName`; `app/config.loginServiceConfig.user{name, email, persons[]{displayName, longName, foreName}}`; JWT claims (`username`, `person_id`, …) |
| Teachers | `masterData.teachers{name (abbreviation), firstName, lastName}`, `getTeachers{foreName, longName, title}`, timetable `te[]{name, longname, orgname}`, REST `position*.{shortName, longName, displayName}`, `calendar-entry.teachers[]`, exams `teachers[]`, `invigilators`, `examBookedUser`/`examModifiedUser`, homework `teachers[]{name}`, `getKlassen.teacher1/2`, `timetable/filter.classTeacher1/2` |
| Students | `getStudents{name, foreName, longName, gender}` (**whole school**), exams `students[]`/`assignedStudents[]` incl. `gender`, `gradeProtection`, **`disadvantageCompensation`**, `timetable/filter.students[]`, absences `studentName`, `studentId` |
| Staff | absences `createdUser`, `updatedUser`, `excuse.username`/`userId` |
| Images | `images.webuntis.com/image/…` (`imageUrl`) |

**Free text that may contain names:** `lessonText`, `lessonInfo`, `substitutionText`, `notesAll`, `texts[].text`, `teachingContent`, `info`, `substText`, `lstext`, `periodText`, `periodInfo`, homework `text`/`remark`, exam `name`/`text`, absence `reason`/`text`/`excuse.text`, message subject/content, messages of the day, file names and contents.

**Secrets** (never hand to agents, never log): app secret and QR code URL, password, TOTP codes, `JSESSIONID`, JWT, signed attachment/image URLs.

### Strategy (see the spec)

1. **Allowlist DTOs** – never pass raw responses through. Exam student lists, `gender`, `gradeProtection` and `disadvantageCompensation` are never mapped.
2. **Teachers: last name only** (plus abbreviation, configurable). First names (`firstName`/`foreName`), titles and images are dropped. First names go into the name dictionary so that they are also removed from free text.
3. **Own account** → `Ich`/`Me`; all other people → stable HMAC pseudonyms with a role.
4. **Name dictionary** from `getStudents` (whole school) and `masterData.teachers` – loaded at startup and kept in memory only. Combined with regexes for e-mail, phone numbers and URLs. Because students may list all students, classmates' names in free text **can be detected**. Names of people outside Untis (e.g. parents, external visitors) cannot.
5. **Absences:** dates and excuse status pass through; reason/text are redacted free text (option to drop them).

## Status of the checks

- [x] School search (public)
- [x] Login options of the instance (`ssoOidc`, native login not hidden)
- [x] Untis Mobile QR code available for the SSO student account
- [x] `getUserData2017` with TOTP → session usable for JSON-RPC, legacy REST and `api/token/new`
- [x] JWT: lifetime 900 s, claim names
- [x] Timetable in all four variants; change info (`removed`/`current`, `orgid`)
- [x] Homework (legacy, intern); REST homework forbidden
- [x] Exams (intern, REST, legacy); JSON-RPC forbidden
- [x] Absences (intern, legacy)
- [x] Rights of a student account (`-8509` list; `getTeachers`/`getStudents` allowed)
- [x] Messages endpoints reachable
- [ ] Message entry/detail schema; whether reading marks as read (no messages in the account)
- [ ] Messages of the day entry schema (none at test time)
- [ ] Attachment downloads (messages, homework, lesson files)
- [ ] Cancelled lessons in `timetable/entries` (none in the window)
- [ ] REST absences request DTO
- [ ] Session idle timeout (`sessionTimeout` value), TOTP clock tolerance

## Probe scripts

| Script | Purpose |
|---|---|
| `scripts/lib.ts` | Terminal input, QR code parser, TOTP (RFC 6238), login (app secret or password), JSON-RPC/intern/REST client with cookie jar and JWT |
| `scripts/dev/probe.ts` (`bun run probe`) | Probes all candidate endpoints above for ±14 days; writes a **redacted** report to `probe-output/report.json` (status, JSON-RPC error codes, field names/types, counts, enum values, URL patterns only). `--save` additionally stores raw data locally (private!). Only reading requests; the only POSTs are the web app's list queries. |

`probe-output/` is gitignored.

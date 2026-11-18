# WebUntis MCP server – specification (v0.1)

As of 2026-11-18 · Status: draft (not implemented yet)
Based on: [`untis-api.md`](./untis-api.md) (✅ verified with a student account, 📦 from the web app bundle, ⏳ still open). Endpoint choices are based on the first probe run (2026-11-18). Endpoints marked ⏳ still lack test data.

---

## 1. Goal and scope

An MCP server that gives AI agents **read-only** access to a WebUntis student account: timetable with changes, homework, exams, own absences, messages and messages of the day. **All personal data is redacted** before it leaves the server, **except the last names of teachers** (and, configurable, their abbreviations).

| In v0.1 | Not in v0.1 (non-goals) |
|---|---|
| Any WebUntis instance (`UNTIS_BASE_URL` + `UNTIS_SCHOOL`) | Write actions (excuses, replies, read confirmations, bookings, office-hour registration) |
| Student accounts, incl. **SSO accounts** via the Untis Mobile app secret (QR code) | Headless OIDC/SAML/Office 365 login (portal passwords are never handled) |
| Native accounts with username/password | Parent accounts with several children (roadmap: `children[]` → `studentId` parameter) |
| Timetable, changes, homework, exams, absences, messages, messages of the day, master data, attachments | Teacher/staff views, class register entries of other students, grades |
| Docker container or local process (stdio) | Several accounts per process (run several containers instead) |

**Principles** (same as the itslearning server)

1. **Read-only.** Only `GET` requests and an explicit allowlist of JSON-RPC read methods (public: `getTimetable`, `getSubjects`, `getRooms`, `getKlassen`, `getTeachers`, `getStudents`, `getHolidays`, `getTimegridUnits`, `getSchoolyears`, `getCurrentSchoolyear`, `getLatestImportTime`; intern: `getUserData2017`, `getHomeWork2017`, `getExams2017`, `getStudentAbsences2017`, `getMessagesOfDay2017`), plus `logout`. Endpoints that change state (read confirmations, `…/read`, replies, deletes) are never called. If `GET messages/{id}` marks a message as read (⏳), the tool description says so.
2. **Allowlist instead of pass-through.** Every tool returns its own slim DTO.
3. **Privacy by default.** Unknown fields are dropped; secrets never leave the server.
4. **Gentle on the instance.** Caching, few parallel requests, no background polling.

---

## 2. Architecture

```
┌──────────────┐  MCP (Streamable HTTP / stdio)  ┌──────────────────────────────────────────────┐
│ Agent/client │ ─────────────────────────────▶ │ server ─▶ tools ─▶ redaction ─▶ DTOs           │
└──────────────┘                                 │              │                                 │
                                                 │              ▼                                 │
                                                 │   api: jsonrpc | intern | legacy | rest        │
                                                 │        ◀── auth (session, TOTP, JWT)           │
                                                 │   masterdata (id → subject/room/teacher)       │
                                                 │   files (refs, cache, text extraction)         │
                                                 └──────────────────────┬───────────────────────┘
                                                                        ▼
                                                        https://<school>.webuntis.com/WebUntis
```

**Stack:** Bun ≥ 1.4, TypeScript (strict), `@modelcontextprotocol/sdk` (Streamable HTTP + stdio), `zod`, Biome. Text extraction with `unpdf` (PDF) and `mammoth` (DOCX), loaded dynamically. No build step – `bun src/server.ts`.

**Modules (`src/`)**

| Module | Responsibility |
|---|---|
| `server.ts` | Entry point, transport selection (`stdio` / `http`), shutdown (calls `logout`) |
| `http.ts` | Stateless Streamable HTTP on `Bun.serve`, bearer API key, `/healthz`, origin check (taken over from itslearning-mcp) |
| `app.ts` | Wiring (`createApp`), server instructions, tool registration |
| `config.ts` | Environment variables + `*_FILE` secrets, QR code parsing, validation (zod) |
| `context.ts` | `AppContext`, `ensureReady()` (login, own element, master data, name dictionary warm-up) |
| `auth/` | `totp.ts` (RFC 6238), `session.ts` (login via secret or password, cookie jar, JWT, single flight, re-login), `loginConfig.ts` (reads `loginServiceConfig` for the startup check) |
| `api/` | `jsonrpc.ts` (public + intern), `legacy.ts`, `rest.ts`; shared limiter, TTL cache, retries, error mapping; typed endpoints |
| `masterdata/` | Resolves IDs to subjects, rooms, classes, teachers (from `getUserData2017`/JSON-RPC), time grid, holidays, school years |
| `files/` | fileRefs, download service, disk cache, text extraction |
| `redaction/` | Person registry, labels (de/en), teacher directory, name dictionary, secret/URL filters, HTML → text (taken over from itslearning-mcp and adapted) |
| `tools/` | One module per tool group: zod schema, handler, DTO mapping |
| `log.ts` | Structured logging to stderr with mandatory scrubbing |

The concrete endpoint behind each tool sits in `api/endpoints.ts`. If a variant (REST view vs. legacy vs. intern) stops working, only that file changes – the DTOs stay the same.

**Endpoint choice (from the probe):**

| Data | Primary | Fallback | Not used (reason) |
|---|---|---|---|
| Timetable | REST `timetable/entries` (+ `timetable/filter` for the own resource) | JSON-RPC `getTimetable` | legacy `weekly/data` (needs format IDs) |
| Lesson details | REST `v2/calendar-entry/detail` | – | – |
| Homework | legacy `api/homeworks/lessons` | intern `getHomeWork2017` | REST `classreg/homework/list` (403 for students) |
| Exams | intern `getExams2017` | – | REST `exams`, legacy `api/exams` (contain participant lists incl. disadvantage-compensation flags) |
| Absences | intern `getStudentAbsences2017` | legacy `api/classreg/absences/students` | REST `classreg/absences` (empty result) |
| Messages | REST `messages`, `messages/status`, `messages/{id}` | – | – |
| Messages of the day | legacy `api/public/news/newsWidgetData` | intern `getMessagesOfDay2017` | – |
| Master data | `getUserData2017.masterData` | JSON-RPC master data methods | – |
| Name dictionary | JSON-RPC `getStudents` + `masterData.teachers` | `getTeachers` | – |

---

## 3. Configuration

All values come from environment variables. Secrets also have a `*_FILE` variant (Docker secrets); if set, it takes precedence.

| Variable | Required | Default | Description |
|---|---|---|---|
| `UNTIS_QR_URL` / `_FILE` | one of the login variants | – | Complete QR code URL `untis://setschool?url=…&school=…&user=…&key=…` – sets base URL, school, user and secret at once |
| `UNTIS_BASE_URL` | ✅ (without QR) | – | e.g. `https://yourschool.webuntis.com` (no path) |
| `UNTIS_SCHOOL` | ✅ (without QR) | – | school login name (`loginName`) |
| `UNTIS_USERNAME` / `_FILE` | ✅ (without QR) | – | WebUntis user name |
| `UNTIS_APP_SECRET` / `_FILE` | one of the login variants | – | Base32 secret of the Untis Mobile QR code |
| `UNTIS_PASSWORD` / `_FILE` | one of the login variants | – | password of a native WebUntis account |
| `MCP_TRANSPORT` | | `stdio` (Docker image: `http`) | `stdio` or `http` |
| `MCP_HOST` | | `127.0.0.1` (Docker image: `0.0.0.0`) | HTTP bind address |
| `MCP_PORT` | | `3000` | HTTP port |
| `MCP_API_KEY` / `_FILE` | ✅ with `http` | – | bearer key for clients (≥ 32 characters) |
| `MCP_ALLOWED_ORIGINS` | | empty | allowed browser origins (DNS-rebinding protection) |
| `REDACTION_LANGUAGE` | | `de` | labels and placeholders: `de` or `en` |
| `REDACTION_SECRET` / `_FILE` | | auto | HMAC secret for pseudonyms (≥ 16 characters); generated once into `DATA_DIR/secret` if missing |
| `REDACTION_KEEP_WORDS` | | empty | words that are never replaced as a single name |
| `REDACT_TEACHERS` | | `false` | `true` → teachers are pseudonymised as well (`Lehrkraft-7F3A`) |
| `KEEP_TEACHER_ABBREVIATIONS` | | `true` | `false` → teacher abbreviations (e.g. `MÜL`) are dropped |
| `ABSENCE_TEXTS` | | `redact` | `redact` (redacted free text) or `drop` (reason/text never emitted) |
| `TIMEZONE` | | `Europe/Berlin` | time zone for "today" and for times without an offset |
| `MAX_RANGE_DAYS` | | `31` | maximum date range per tool call |
| `MAX_FILE_MB` | | `25` | larger files are rejected |
| `CACHE_TTL_S` | | `60` | lifetime of the list cache |
| `MAX_CONCURRENCY` | | `2` | parallel requests to WebUntis |
| `MIN_REQUEST_INTERVAL_MS` | | `200` | minimum spacing between requests |
| `DATA_DIR` | | `/data` | persistence (pseudonym secret, teacher directory, file cache) |
| `DOWNLOAD_DIR` | | – | optional: also store downloaded files here (redacted file name) |
| `LOG_LEVEL` | | `info` | `debug` \| `info` \| `warn` \| `error` |

Exactly one login variant must be configured (QR code, secret or password). Otherwise the server does not start, and the error message never prints secrets.

---

## 4. Authentication and session

### 4.1 Startup

1. The server reads the configuration. If `UNTIS_QR_URL` is set, it parses the QR code.
2. **Login:**
   - **App secret:** `jsonrpc_intern.do getUserData2017` with `auth {user, otp, clientTime}`, then the `JSESSIONID` cookie.
   - **Password:** `jsonrpc.do authenticate`.
3. **Compatibility check** on failure. The server fetches the public `loginServiceConfig` of the instance:
   - Password login fails, but `ssoOidc`/SAML/Office 365 is active → `SSO_ACCOUNT_NEEDS_SECRET`: "use the Untis Mobile QR code (Profile → Sharing)".
   - `-8504` / invalid OTP → `AUTH_FAILED` (**fatal**, see 4.2).
   - The school is unknown (school search / `-8500`-range error) → "check UNTIS_BASE_URL/UNTIS_SCHOOL".
4. The server determines its own element: `userData.elemId/elemType` or `personId/personType`. The own class comes from `GET /api/daytimetable/config` (`data.klasseId`), because `userData.klassenIds` is empty for students. The server then loads the master data (`masterData` from `getUserData2017`, otherwise JSON-RPC) and registers all teachers. It also loads `getStudents` once (whole school) for the name dictionary. That list stays in memory only and is never written to disk or logs.
5. The server starts even if login fails. Tools then return the error in a structured way.

### 4.2 Session lifecycle

- **No refresh token.** Session = `JSESSIONID` (+ JWT for the REST view API). Nothing has to be persisted.
- **JWT:** fetched from `GET /api/token/new` on demand (lifetime 900 s) and renewed 60 s before `exp`. The JWT contains personal claims (`username`, `person_id`) and is treated as a secret.
- **Re-login** on `-8520`, on a `302` to the login page or on a REST `401`: one new login, then the request is retried once. The server uses **single flight** here, so parallel requests wait for the same login.
- **TOTP:** the code is computed per request with the current `clientTime`. On an OTP error the server retries once with the next time step (clock skew). After that the error is fatal. The server checks its system clock at startup against the `Date` header of the instance and logs a warning if the difference is > 30 s.
- **Fatal errors** (wrong password, invalid secret): no further login attempts until restart, so that a container restart loop cannot lock the account.
- **Shutdown:** `logout` (best effort).

---

## 5. Tools

Conventions:
- Names are prefixed `untis_`. All tools are annotated `readOnlyHint: true`, `openWorldHint: false`.
- **Dates:** input `YYYY-MM-DD` (default: today in `TIMEZONE`). Output: `date` `YYYY-MM-DD`, times `HH:MM`. Ranges are limited to `MAX_RANGE_DAYS` (`RANGE_TOO_LARGE`).
- **IDs:** only Untis IDs of lessons, homework, exams, messages and absences that are needed for follow-up calls. **No person IDs** (`personId`, `studentId`, `userId`, teacher IDs) are emitted. Teachers appear only as `Teacher`.
- **Files** are referenced only via `fileRef` (5.11).
- Every result is returned as `structuredContent` **and** as text (summary + JSON). Everything the agent needs is in `structuredContent`.
- Errors: `isError: true` with a code (section 9).

Common types:

```ts
type Teacher = { name: string; abbreviation?: string; status?: "regular" | "substitute" | "removed" };
// name = last name ("Müller"), or with REDACT_TEACHERS "Lehrkraft-7F3A"; never a first name
type Person = { display: string; role: "self" | "teacher" | "student" | "parent" | "staff" | "unknown" };
type Subject = { short: string; name?: string };
type Room = { short: string; name?: string; status?: "regular" | "substitute" | "removed" };
type FileRefDto = { fileRef: string; name: string; kind: "file" | "image" | "unknown"; sizeBytes?: number };
type LessonStatus = "regular" | "cancelled" | "substitution" | "room_change" | "additional" | "moved" | "exam" | "event";
```

| # | Tool | Input | Output (main fields) | Endpoints (primary · fallback) |
|---|---|---|---|---|
| 5.1 | `untis_overview` | `date?`, `days` (2) | `days[]{date, lessons (count), changes[], firstLesson, lastLesson}`, `homeworkDue[]`, `upcomingExams[]` (14 days), `unreadMessages`, `messagesOfDay[]` | combination of 5.2, 5.4, 5.5, 5.7, 5.9 |
| 5.2 | `untis_get_timetable` | `startDate?`, `endDate?` (default: current week), `includeCancelled` (true) | `days[]{date, dayStatus, holiday?, lessons[]{lessonRef, lessonId, start, end, periods (e.g. "3-4"), subject, teachers[], rooms[], classes[], status, statusDetails[], substitutionText?, lessonText?, info?, homework (bool), exam?}}` | `rest/view/v1/timetable/entries` · `getTimetable` |
| 5.3 | `untis_list_changes` | `startDate?`, `days` (7) | only lessons with status ≠ `regular`, incl. the **original** teacher/room (`teachers[].status`, `rooms[].status`) and texts | like 5.2 |
| 5.4 | `untis_list_homework` | `startDate?`, `endDate?`, `openOnly` (false) | `homework[]{homeworkId, assigned, due, subject, teacher, text, remark?, completed, attachments[]: FileRefDto}` | `api/homeworks/lessons` · `getHomeWork2017` |
| 5.5 | `untis_list_exams` | `startDate?`, `endDate?` (default: 6 weeks) | `exams[]{examId, date, start, end, type, name, subject, teachers[], rooms[], text?}` – no participant lists, no grades | `getExams2017` (IDs → master data) |
| 5.6 | `untis_list_absences` | `startDate?` (default: school year start), `endDate?`, `status` (all\|open\|excused\|unexcused) | `absences[]{absenceId, start, end, lessons?, excuseStatus, reason?, text?}`, `totals{count, open, excused, unexcused, lessons?}` | `getStudentAbsences2017` · `api/classreg/absences/students` |
| 5.7 | `untis_list_messages` | `limit` (20), `unreadOnly`, `search?` | `messages[]{messageId, sent, subject, preview, from: Person, read, hasAttachments, requiresConfirmation}`, `unread` | `rest/view/v1/messages`, `messages/status` (entry schema ⏳) |
| 5.8 | `untis_get_message` | `messageId` | `message{messageId, sent, subject, from, text (HTML → Markdown, redacted), attachments[]: FileRefDto, recipientsSummary}` | `rest/view/v1/messages/{id}?contentAsHtml=true` ⏳ |
| 5.9 | `untis_messages_of_day` | `date?` | `items[]{subject, text, attachments[]}` | `api/public/news/newsWidgetData` · `getMessagesOfDay2017` |
| 5.10 | `untis_get_master_data` | `include[]` (subjects, teachers, rooms, timegrid, holidays, schoolyears) | `subjects[]`, `teachers[]` (last name + abbreviation only), `rooms[]`, `timegrid[]{period, start, end}`, `holidays[]{name, start, end}`, `schoolyears[]`, `currentSchoolyear` | `getUserData2017.masterData` · JSON-RPC |
| 5.11 | `untis_download_file` | `fileRef`, `mode` (auto\|text\|blob\|both), `maxTextChars` | metadata + `text` (redacted) and/or file/image content | see 5.11 |
| 5.12 | `untis_get_lesson` | `lessonRef` (from 5.2: `<date>_<periodId>`) | `lesson{…5.2 fields, topic (teachingContent), notes?, homework[], exam?, files[]: FileRefDto}` | `rest/view/v2/calendar-entry/detail` |

Details:

- **Lesson status (5.2/5.3):** mapped from the entry `status` (observed: `REGULAR`, `CHANGED`, `ADDED`, `REMOVED`; bundle: `CANCELLED`, `ADDITIONAL`) + `statusDetail` + `position*.current/removed` (REST view), `code`/`lstype` + `orgid` (JSON-RPC), `is[]` (intern) or `cellState` (legacy) to `LessonStatus`. Consecutive periods of the same lesson are merged (`periods: "3-4"`). For substitutions, the original teacher stays in `teachers[]` with `status: "removed"` and the substitute with `status: "substitute"`.
- **Overview (5.1):** "today" plus `days - 1` school days (weekends/holidays are skipped). `changes` = lessons with status ≠ `regular`. Homework due today/tomorrow, exams in the next 14 days, unread messages count, messages of the day for today.
- **Homework (5.4):** default window: 7 days back to 14 days ahead. Subject from `lessons[].subject`, teacher from `records[].teacherId` → master data (last name). The legacy `teachers[].name` is not used directly.
- **Exams (5.5):** taken from `getExams2017`, which has no participant lists. The REST/legacy exam endpoints are not used because they list all participants incl. `gender`, `gradeProtection` and `disadvantageCompensation`. If they are ever used as a fallback, these fields and `grade` are never mapped.
- **Lesson (5.12):** `lessonRef` is the date plus the first period ID from `timetable/entries`; the tool resolves it via `calendar-entry/detail`. `topic` = `teachingContent` (redacted free text). Lesson files (`teachingContentFiles`, `notesAllFiles`) become fileRefs `l_<date>_<periodId>_<n>`. `notesStaff`, `students[]` and `permissions` are never mapped.
- **Absences (5.6):** sensitive. The tool description says that reasons can contain health data. `ABSENCE_TEXTS=drop` removes `reason`/`text` completely. `createdUser`/`updatedUser`/`studentName` are never emitted.
- **Messages (5.7/5.8):** the sender becomes `Person` (teacher → last name, otherwise pseudonym). The recipient list is only summarised (`recipientsSummary`, e.g. "class 7b, parents"). Read confirmations are never sent. `requiresConfirmation: true` only informs the agent that confirmation must happen in WebUntis.

### 5.11 Files

**fileRefs** contain only Untis IDs (no secrets) and are resolvable **statelessly** (also after a restart):

| fileRef | Source | Resolution |
|---|---|---|
| `m_<messageId>_<n>` | message attachment | re-read the message → n-th attachment → `attachmentstorageurl` or `messages/{id}/attachment` ⏳ |
| `h_<homeworkId>_<n>` | homework attachment | re-read the homework of the range/lesson → n-th attachment ⏳ |
| `d_<date>_<n>_<k>` | message-of-the-day attachment | re-read `newsWidgetData` for the date ⏳ |
| `l_<date>_<periodId>_<n>` | lesson file (`teachingContentFiles`, `notesAllFiles`) | re-read `calendar-entry/detail` ⏳ |

Behaviour (as in itslearning-mcp):
- `mode=auto` (default): PDF/DOCX/text → **redacted text only**; images → image content; other formats → `resource` blob.
- Files larger than `MAX_FILE_MB` → `FILE_TOO_LARGE`.
- Signed storage URLs stay inside the `FileService` and are never emitted or logged.
- Disk cache in `DATA_DIR/files` (24 h, max. 500 MB). `DOWNLOAD_DIR` optional (`savedTo`).
- **Known limit:** blob/image content is not redacted, only extracted text is. The tool description says so.

---

## 6. Redaction

`src/redaction/` is taken over from itslearning-mcp (registry, labels, teacher directory, free text, secrets, HTML) and adapted to Untis.

### 6.1 Rule: what may leave the server

| Data | Output |
|---|---|
| Teacher **last name** (`longName`/`longname`) | ✅ unchanged (e.g. `Müller`); with `REDACT_TEACHERS=true` → `Lehrkraft-7F3A` |
| Teacher abbreviation (`name`) | ✅ if `KEEP_TEACHER_ABBREVIATIONS=true` (default) |
| Teacher first name, title, image, e-mail | ❌ never |
| Own account (name, user name, IDs) | ❌ → `Ich` / `Me` |
| Classmates, parents, staff, other senders | ❌ → pseudonym with role (`Schüler:in-7F3A`, `Elternteil-2B91`, `Person-C04E`) |
| Classes, subjects, rooms, times, statuses | ✅ (not personal data in themselves) |
| School name/address | ❌ not emitted (the agent does not need them) |
| Person IDs of any kind | ❌ never |
| Gender, grade protection, disadvantage compensation, grades | ❌ never |

### 6.2 Person registry

Every person seen in a structured field is registered. Untis has no stable person ID for all sources, so the key is (`elementType`, `id`) for elements and (`userId`) for message senders, plus the normalised name as a fallback.

| Source | Role |
|---|---|
| `userData` / `authenticate` | `self` |
| master data teachers, timetable `te[]`, `TEACHER` resources, homework/exam `teachers[]` | `teacher` |
| message `sender` with role `TEACHER`/`DIRECTORATE` (`MessageUserRole`) | `teacher` / `staff` |
| message `sender` with role `STUDENT`/`PARENT`/`LEGAL_GUARDIAN` | `student` / `parent` |
| JSON-RPC `getStudents` (whole school, loaded at startup, refreshed with the master data) | `student` (names only for the dictionary; the list is never emitted, cached on disk or logged) |
| absences `studentName` (own name) | `self` |

**Teachers whose last name is not known** (e.g. only the abbreviation is visible) are shown by abbreviation only. **Teacher directory** `DATA_DIR/teachers.json` (as in itslearning-mcp, maintained by the user) can add salutations: `{ "teachers": [ { "abbreviation": "MÜL", "lastName": "Müller", "salutation": "Frau" } ] }` → `Frau Müller`. Salutations are never guessed.

### 6.3 Labels (`REDACTION_LANGUAGE`)

| Role | `de` (default) | `en` |
|---|---|---|
| own account | `Ich` | `Me` |
| teacher | `Müller` / `Frau Müller` | `Müller` / `Mrs Müller` |
| teacher with `REDACT_TEACHERS=true` | `Lehrkraft-7F3A` | `Teacher-7F3A` |
| student | `Schüler:in-7F3A` | `Student-7F3A` |
| parent | `Elternteil-7F3A` | `Parent-7F3A` |
| staff / unknown | `Person-7F3A` | `Person-7F3A` |

Pseudonym = start of `HMAC-SHA256(REDACTION_SECRET, baseUrl | school | key)`, 4 characters; on collision 6. Placeholders: `[E-Mail]`, `[Telefon]`, `[Link entfernt]`, `[Name]` (en: `[email]`, `[phone]`, `[link removed]`, `[name]`).

### 6.4 Free text

Applies to: lesson text, substitution text, info/notes, homework text/remark, exam name/text, message subject/content/preview, messages of the day, absence reason/text, file names, extracted file text.

Pipeline (as in itslearning-mcp):
1. HTML → text/Markdown (scripts/styles removed).
2. URL filters: only external links with unsuspicious parameters remain; WebUntis/session/storage links → `[Link entfernt]`.
3. E-mail addresses, phone numbers, ID pairs.
4. **Name dictionary:** own name (all variants), all students of the school (`getStudents`) and names of parents/staff from structured fields → labels; **teacher first names** are removed ("Hans Müller" → "Müller", "Herr Hans Müller" → "Herr Müller"), and the last name stays. Word-boundary based, case-insensitive, longest match first. Single first names are only replaced if they are ≥ 3 characters and not a stop word or in `REDACTION_KEEP_WORDS`.
5. Length limit per tool.

**Special risk in Untis:** short codes in timetable texts (`lstext`, `info`) are often abbreviations (teacher abbreviations, groups). Teacher abbreviations are allowed, so they are not replaced.

### 6.5 Secrets

**Never emitted, never logged:** app secret, QR code URL, password, TOTP codes, `JSESSIONID`, JWT, MCP API key, signed storage URLs, image URLs (`images.webuntis.com`). The logger scrubs these registered values and reduces URLs to patterns.

### 6.6 Limits

- The student account may list all students (`getStudents`), so the names of everyone at the school are detected in free text. **Not** detected: people outside Untis (parents, external people). Common first names that are also ordinary words are a trade-off (`REDACTION_KEEP_WORDS`). If a school withdraws the right for `getStudents` (`-8509`), the server logs a warning and continues with the names from structured fields only.
- Names in images, scans and file blobs are not redacted.
- Pseudonymisation is not anonymisation (GDPR). Absence reasons can be health data – the default `redact` still lets the agent see the redacted reason.

---

## 7. Caching and rate limiting

| What | How |
|---|---|
| Master data, school years, time grid, holidays | 15 min; invalidated when `getLatestImportTime` changes |
| Lists (timetable, homework, exams, absences, messages) | in-memory TTL cache (`CACHE_TTL_S`, 60 s), keyed by range; in-flight requests are shared |
| JWT | until 60 s before `exp` |
| Files | disk cache `DATA_DIR/files`, 24 h, max. 500 MB |
| Concurrency | `MAX_CONCURRENCY` (2), `MIN_REQUEST_INTERVAL_MS` (200 ms) for all API families together |
| Retries | `429`/`5xx`/network: 3 attempts, exponential backoff, `Retry-After` honoured; never for login errors |
| Background | no requests without a tool call (except login + master data at startup) |
| Ranges | long ranges are split into weeks (timetable) and requested sequentially |

---

## 8. Transport and operation

### 8.1 Transports

As in itslearning-mcp:
- **`stdio`** (default): `bun src/server.ts` or `docker run -i`.
- **`http`**: Streamable HTTP at `POST /mcp`, stateless (JSON responses, no SSE; `GET`/`DELETE` → 405). The server creates a fresh `McpServer` per request on the shared context. `Authorization: Bearer <MCP_API_KEY>` with constant-time comparison, `GET /healthz` without auth, origin check, 1 MB body limit, no TLS in the container.

### 8.2 Docker

- `Dockerfile`: `oven/bun:<pinned>-alpine`, no bundling, user `bun` (UID 1000), `VOLUME /data`, `HEALTHCHECK` on `/healthz`, defaults `MCP_TRANSPORT=http`, `MCP_HOST=0.0.0.0`, `TZ=Europe/Berlin`.
- `compose.yaml`: port `127.0.0.1:3000:3000`, secrets from `./secrets/` (`untis_qr_url` **or** `untis_app_secret` + `untis_username`, `mcp_api_key`), read-only root filesystem, `tmpfs /tmp`, `cap_drop: [ALL]`, `no-new-privileges`.
- Later: GHCR images on version tags (`ghcr.io/ludoo0/untis-mcp`), CI (lint, typecheck, test), Dependabot – as in itslearning-mcp.

---

## 9. Error handling

| Code | Cause | Message to the agent |
|---|---|---|
| `AUTH_FAILED` | wrong password / invalid secret / OTP rejected twice | credentials wrong – fix the configuration and restart |
| `SSO_ACCOUNT_NEEDS_SECRET` | password login not possible, instance uses SSO | use the Untis Mobile QR code |
| `NO_RIGHT` | JSON-RPC `-8509`, REST `403` | the account may not see this |
| `OUT_OF_RANGE` | JSON-RPC `-7004`, outside the school year | choose a date in the current school year |
| `RANGE_TOO_LARGE` | range > `MAX_RANGE_DAYS` | with the limit |
| `NOT_FOUND` | unknown id / `404` | fetch the list again |
| `RATE_LIMITED` | `429` after retries | WebUntis is throttling |
| `UPSTREAM_ERROR` | `5xx`/network after retries | WebUntis unreachable |
| `FILE_REF_UNKNOWN` | invalid or no longer resolvable fileRef | fetch the list again |
| `FILE_TOO_LARGE` | > `MAX_FILE_MB` | with size |
| `INVALID_INPUT` | schema validation | with field |

Raw error texts (they may contain IDs or names) are never passed through. They are logged sanitised only.

---

## 10. Tests

- **Unit/integration tests** (`bun test`, no network, **fictional data only**, e.g. "Jonas Beispielmann", "Frau Lindqvist"):
  - config incl. QR parsing
  - TOTP against the RFC 6238 test vectors
  - session (re-login, single flight, fatal errors)
  - API clients against a fake WebUntis (JSON-RPC, intern, legacy, REST)
  - status mapping of all four timetable variants
  - redaction (teacher first names removed / last names kept, own name, pseudonyms, URLs, secrets)
  - all tools
  - HTTP transport, MCP protocol in-memory
  - leak tests over all tool outputs (no first names, IDs, secrets)
- **Smoke test** against the real account (`bun run smoke [--details]`, run by the maintainer): calls every tool once, fetches the real names via the API and checks every output against them (only teacher last names are allowed) and against secret patterns. Output is masked (letters → `x`, digits → `9`) and shareable. Exit code 1 on findings.
- **Probe** (`bun run probe`) as described in `untis-api.md`, before and during implementation.

# untis-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for **WebUntis** (school timetable system): lets AI agents read the timetable, timetable changes, homework, exams, absences and messages of a **student account** – with **redaction of personal data**. Only the last names (and abbreviations) of teachers are shown; the student appears as "Ich"/"Me", everybody else as a pseudonym.

- Works with SSO accounts (e.g. school portal login): login via the **Untis Mobile QR code** (app secret + TOTP). Native accounts can also use a password.
- Bun + TypeScript, stdio or Streamable HTTP, Docker image.
- Specification: [`docs/mcp-server-spec.md`](docs/mcp-server-spec.md) · API findings: [`docs/untis-api.md`](docs/untis-api.md)

## Tools

| Tool | Content |
|---|---|
| `untis_overview` | today + next school day: lessons, changes, homework due, exams, unread messages, messages of the day |
| `untis_get_timetable` | timetable for a range (default: current week), double lessons merged, changes with original/new teacher and room |
| `untis_list_changes` | only cancellations, substitutions, room changes, additional/moved lessons |
| `untis_get_lesson` | lesson topic, notes, homework and files of one lesson |
| `untis_list_homework` | homework with due date, subject, teacher, attachments |
| `untis_list_exams` | exams (no participant lists, no grades) |
| `untis_list_absences` | own absences with excuse status and totals |
| `untis_list_messages`, `untis_get_message` | message centre ("Mitteilungen") |
| `untis_messages_of_day` | school-wide messages of the day |
| `untis_get_master_data` | subjects, teachers, rooms, classes, time grid, holidays, school years |
| `untis_download_file` | attachments; PDF/DOCX/text as redacted text |

All tools are read-only. The server never sends read confirmations, replies or excuses.

## Privacy

- Every tool returns its own slim DTO (allowlist) – raw API responses never reach the agent.
- Teachers: last name + abbreviation (`KEEP_TEACHER_ABBREVIATIONS`), never first names; optional salutation via `DATA_DIR/teachers.json`; `REDACT_TEACHERS=true` pseudonymises them too.
- The student → `Ich`; classmates → `Schüler:in-7F3A`; parents → `Elternteil-…`; others → `Person-…` (stable HMAC pseudonyms).
- Free text (lesson texts, homework, messages, file text) goes through a name dictionary built from **all students and teachers of the school** (kept in memory only), plus filters for e-mail addresses, phone numbers, WebUntis/storage links and tokens.
- Never in the output: person ids, gender, exam participant lists, disadvantage-compensation flags, grades, staff notes.
- **Limits:** names of people outside WebUntis (e.g. parents who never wrote a message) are not detected in free text; images and file blobs are not redacted; absence reasons can be health data (`ABSENCE_TEXTS=drop` removes them). Pseudonymisation is not anonymisation.

## Setup

### 1. Get the app secret (QR code)

In WebUntis (browser, logged in as the student): **profile → "Freigaben" (sharing) → Untis Mobile → show**. The QR code contains a link like

```
untis://setschool?url=yourschool.webuntis.com&school=yourschool&user=USERNAME&key=SECRET
```

Read it with a QR reader app (no online service – the key works like a password) or copy server, school, user and key from the text shown next to the code. Creating a new QR code invalidates the old key.

### 2a. Docker (HTTP)

```bash
cp -r secrets.example secrets     # PowerShell: Copy-Item -Recurse secrets.example secrets
# fill secrets/untis_qr_url and secrets/mcp_api_key (see secrets.example/README.txt)
docker compose up -d --build
```

The server listens on `http://127.0.0.1:3000/mcp` (bearer API key), health check at `/healthz`. Connect e.g. Claude Code:

```bash
claude mcp add --transport http untis http://127.0.0.1:3000/mcp --header "Authorization: Bearer <MCP_API_KEY>"
```

### 2b. Local (stdio)

```bash
bun install
cp .env.example .env              # set UNTIS_QR_URL (or the single values)
claude mcp add untis -- bun run /path/to/untis-mcp/src/server.ts
```

## Configuration

See [`.env.example`](.env.example) and spec section 3. Most important:

| Variable | Default | |
|---|---|---|
| `UNTIS_QR_URL` (`_FILE`) | – | QR code link (sets server, school, user, secret) |
| `UNTIS_BASE_URL`, `UNTIS_SCHOOL`, `UNTIS_USERNAME` + `UNTIS_APP_SECRET` or `UNTIS_PASSWORD` | – | alternative to the QR link |
| `MCP_TRANSPORT` | `stdio` (Docker: `http`) | `stdio` or `http` |
| `MCP_API_KEY` (`_FILE`) | – | required for `http`, ≥ 32 characters |
| `REDACTION_LANGUAGE` | `de` | `de` / `en` |
| `REDACT_TEACHERS` | `false` | pseudonymise teachers too |
| `ABSENCE_TEXTS` | `redact` | `drop` → never return absence reasons/texts |
| `TIMEZONE` | `Europe/Berlin` | school time zone |
| `DATA_DIR` | `/data` | pseudonym secret, `teachers.json`, file cache |

## Development

```bash
bun install
bun run lint && bun run typecheck && bun test   # tests use fictional data only, no network
bun run call [tool] [key=value…]                # call a tool against the real account (.env)
bun run smoke [--details]                       # leak check against the real account – output is masked and shareable
bun run probe                                   # structure-only API probe (docs/untis-api.md)
```

## License

MIT – not affiliated with Untis GmbH.

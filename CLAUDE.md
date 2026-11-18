# untis-mcp – context for agents

Read-only MCP server for **WebUntis** that lets AI agents read the timetable, changes, homework, exams, absences and messages of a student account – with **redaction of personal data** (only teacher last names/abbreviations are shown). Sister project of `itslearning-mcp` (same structure and rules).

- Open items: [`docs/roadmap.md`](docs/roadmap.md) · Changes: [`CHANGELOG.md`](CHANGELOG.md)
- Specification: [`docs/mcp-server-spec.md`](docs/mcp-server-spec.md) · Verified API findings: [`docs/untis-api.md`](docs/untis-api.md)
- Project language: **English** (code, comments, docs, tool descriptions). Redaction labels: `de` (default) and `en`.

## Privacy – hard rules

Developed against a real student account. **Never commit anything identifying an instance, school, person or class.**

- Never in the repository: instance hosts, school names/login names, tenant ids, real names, ids, content of `probe-output/`, `.data/`, `downloads/`, `secrets/`, `.env` (all gitignored).
- Before every commit, search the staged diff for identifying terms (the maintainer knows them – do not write them down here).
- Test data is fictional (`test/fixtures.ts`). Never put real data into tests.
- Bun loads `.env` automatically – it may contain the real QR secret. Never run `call`, `smoke` or `probe` unless the maintainer asks; when starting the server locally for tests, override `UNTIS_QR_URL` with a dummy (`untis://setschool?url=example.invalid&school=x&user=x&key=ABCDEFGHIJKLMNOP`) and set `DATA_DIR` to a scratch directory.
- Shareable output (probe report, smoke test) contains structure/counts only (masking `x`/`9`).

## Architecture (short)

| Path | Content |
|---|---|
| `src/auth/` | `totp.ts` (RFC 6238), `session.ts` (login via app secret `getUserData2017` or password, cookie jar, JWT from `api/token/new`, single-flight re-login, retries; rejected secret/password = fatal) |
| `src/api/` | `endpoints.ts` (all endpoints, TTL cache), `types.ts` (raw shapes), limiter, cache |
| `src/masterdata.ts` | id → subject/room/class/teacher, time grid, holidays, school years |
| `src/context.ts` | `ensureReady()`: login, own student id, master data, teachers + **all students** (`getStudents`) into the name dictionary |
| `src/redaction/` | `people.ts` (registry, pseudonyms, teacher labels, name lookup), `names.ts` (token-based dictionary), `secrets.ts`, `html.ts`, `teachers.ts` (`teachers.json`), `redactor.ts` |
| `src/tools/` | one module per group; DTOs are allowlists |
| `src/files/` | stateless fileRefs (`m_`, `h_`, `d_`, `l_`), download service, cache, text extraction |
| `scripts/` | `call.ts`, `smoke.ts` (leak check), `dev/probe.ts` |

### Invariants
- Register people before redacting text (message senders in `listMessages`).
- Every free text goes through `ctx.redactor.text()/title()/optional()`, file names through `redactFileName()`.
- Never map exam participant lists, gender, `gradeProtection`, `disadvantageCompensation`, grades, `notesStaff`, `students[]`.
- Never call state-changing endpoints (read confirmations, replies, deletes). JSON-RPC methods are an allowlist (spec 1).
- Logs go to stderr; never log content. Secrets/JWT/JSESSIONID are registered with the logger.

## Commands

```bash
bun install
bun run lint && bun run typecheck && bun test
docker compose up -d --build
```

## Working with the maintainer

- Commits, pushes and any other git/GitHub write operation only after explicit approval (global rules in `~/.claude/CLAUDE.md`). Main branch: `master`.
- Real-account tests (`bun run smoke`, `bun run call`, `bun run probe`) are run by the maintainer; they share the masked output.
- For every redaction gap: reproduce with a structure-only diagnosis, add a regression test with fictional data, then fix.

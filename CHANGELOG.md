# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-18

First release.

### Added

- Read-only MCP server for WebUntis student accounts, stdio and stateless Streamable HTTP transport (bearer API key, `/healthz`, origin check).
- Login via the **Untis Mobile app secret** (QR code link `UNTIS_QR_URL`, TOTP per RFC 6238) – also for accounts that log in through a school portal (SSO) – or via username/password for native accounts. Session cookie + JWT handling, single-flight re-login, retries with backoff, rate limiting; a rejected secret/password is fatal (no login loop, no account lockout).
- 12 tools: `untis_overview`, `untis_get_timetable`, `untis_list_changes`, `untis_get_lesson`, `untis_list_homework`, `untis_list_exams`, `untis_list_absences`, `untis_list_messages`, `untis_get_message`, `untis_messages_of_day`, `untis_get_master_data`, `untis_download_file`.
- Timetable from the REST view API with JSON-RPC fallback; double lessons merged; changes with original (`removed`) and new (`substitute`) teacher/room.
- Redaction: teachers by last name + abbreviation (never first names, optional salutation via `teachers.json`, `REDACT_TEACHERS`), the owner as `Ich`/`Me`, everyone else as stable HMAC pseudonyms; token-based name dictionary with all students and teachers of the school (case-, diacritic- and transliteration-insensitive, parts of compound names); filters for e-mail, phone numbers, WebUntis/storage links, JWTs and id pairs. Exam participant lists, gender, disadvantage-compensation flags, grades and staff notes are never mapped. `ABSENCE_TEXTS=drop` removes absence reasons/texts.
- Attachments via stateless fileRefs with redacted text extraction (PDF, DOCX, text) and disk cache.
- Docker image (Bun, Alpine, non-root, read-only root filesystem in compose), CI, release workflow publishing to GHCR.
- Developer scripts: `bun run call`, `bun run smoke` (leak check with masked, shareable output), `bun run probe` (structure-only API probe).

### Known limitations

- Not yet verified with real data (none in the reference account): message content and attachments, homework attachments, lesson files, messages of the day with content, cancelled lessons in the REST timetable.
- Names of people who never appear in a structured field (e.g. parents who did not write a message) are not detected in free text; images and file blobs are not redacted.
- Parent accounts are not supported.

[Unreleased]: https://github.com/Ludoo0/untis-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Ludoo0/untis-mcp/releases/tag/v0.1.0

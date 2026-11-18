# Roadmap / open items

As of 2026-11-18 (v0.1.0)

## Verification with real data (⏳ in `untis-api.md`)

- Message entry/detail schema, attachments (`attachmentstorageurl` vs. `messages/{id}/attachment`), and whether opening a message marks it as read.
- Homework attachments (legacy `attachments[]`: `url` or id-based download).
- Lesson files (`teachingContentFiles`, `notesAllFiles`) – download location.
- Messages of the day with content and attachments.
- Cancelled/additional lessons in `timetable/entries` (status values `CANCELLED`, `ADDITIONAL`).
- Session idle timeout, TOTP clock tolerance.
- REST absences request DTO (currently the mobile API is used).

## Features

- Parent accounts (`children[]` in the user data, `studentId` parameter per tool).
- Office hours, class register events (if the rights allow it for students).
- Compatibility check (`bun run check <school>`): public login options of an instance (SSO, native login) without an account.

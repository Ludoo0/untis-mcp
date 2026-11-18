import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { Untis } from "./api/endpoints";
import { Limiter } from "./api/limiter";
import { UntisSession } from "./auth/session";
import type { Config } from "./config";
import { type AppContext, createContext } from "./context";
import { FileCache } from "./files/cache";
import { FileService } from "./files/service";
import { registerSecret } from "./log";
import { getLabels } from "./redaction/labels";
import { PersonRegistry } from "./redaction/people";
import { Redactor } from "./redaction/redactor";
import { loadOrCreateSecret } from "./redaction/secretKey";
import { TeacherDirectory } from "./redaction/teachers";
import { registerFileTools } from "./tools/files";
import { registerMessageTools } from "./tools/messages";
import { registerOverviewTools } from "./tools/overview";
import { registerSchoolworkTools } from "./tools/schoolwork";
import { registerTimetableTools } from "./tools/timetable";

export const INSTRUCTIONS = `Read-only access to the WebUntis account of a student (school timetable system).
- Start with untis_overview (today and the next school day: lessons, changes, homework due, exams, unread messages).
- Timetable: untis_get_timetable (a week by default), only changes: untis_list_changes; details of a lesson (topic, notes, files): untis_get_lesson with lessonRef.
- Homework: untis_list_homework. Exams: untis_list_exams. Own absences: untis_list_absences (sensitive – only when asked).
- Messages: untis_list_messages → untis_get_message. School-wide notices: untis_messages_of_day.
- Subjects, teachers, time grid, holidays: untis_get_master_data.
- Files: tools return fileRef values → untis_download_file (PDF/DOCX/text as redacted text).
- Privacy: the student appears as "Ich"/"Me", teachers by last name and abbreviation (never first names), all other people as pseudonyms ("Schüler:in-7F3A", "Person-7F3A"). Emails, phone numbers and WebUntis links are removed. Do not try to reconstruct redacted data.
- Dates are in the school's time zone. The server cannot change anything (no excuses, no replies, no read confirmations).`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "untis-mcp", version: pkg.version }, { instructions: INSTRUCTIONS });
  registerOverviewTools(server, ctx);
  registerTimetableTools(server, ctx);
  registerSchoolworkTools(server, ctx);
  registerMessageTools(server, ctx);
  registerFileTools(server, ctx);
  return server;
}

export function createApp(cfg: Config) {
  registerSecret(cfg.apiKey);
  const limiter = new Limiter(cfg.maxConcurrency, cfg.minRequestIntervalMs);
  const session = new UntisSession({ baseUrl: cfg.baseUrl, school: cfg.school, username: cfg.username, login: cfg.login, limiter });
  const untis = new Untis(session, cfg.cacheTtlS * 1000);
  const people = new PersonRegistry({
    secret: loadOrCreateSecret(cfg.dataDir, cfg.redactionSecret),
    scope: `${cfg.baseUrl}|${cfg.school}`,
    labels: getLabels(cfg.redactionLanguage),
    redactTeachers: cfg.redactTeachers,
    keepAbbreviations: cfg.keepTeacherAbbreviations,
    directory: new TeacherDirectory(join(cfg.dataDir, "teachers.json")),
    keepWords: new Set(cfg.redactionKeepWords),
  });
  const files = new FileService((p, max) => untis.download(p, max), {
    maxBytes: cfg.maxFileMb * 1_048_576,
    cache: new FileCache(join(cfg.dataDir, "files")),
  });
  const ctx = createContext({ cfg, untis, redactor: new Redactor(people), files });
  return { ctx, session, server: createServer(ctx) };
}

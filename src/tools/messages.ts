/**
 * Messages ("Mitteilungen") and messages of the day (spec 5.7–5.9).
 * Never sends read confirmations, replies or deletes.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MessageAttachment, MessageDetail, MessageListItem, MessageSender } from "../api/types";
import type { AppContext } from "../context";
import { dateOf, parseDateInput, timeOf } from "../dates";
import type { Person } from "../redaction/people";
import { compact, dateInput, type FileRefDto, fileRefDto } from "./common";
import { handler, ok, READ_ONLY } from "./result";

export type MessageDto = {
  messageId: number;
  sent?: string;
  subject: string;
  preview?: string;
  from?: Person;
  read?: boolean;
  hasAttachments?: boolean;
  requiresConfirmation?: boolean;
};

const at = (dt?: string) => {
  const d = dateOf(dt);
  const t = timeOf(dt);
  return d ? (t ? `${d} ${t}` : d) : undefined;
};

export function senderPerson(ctx: AppContext, s: MessageSender | undefined): Person | undefined {
  if (!s) return undefined;
  const key = s.userId !== undefined ? `user:${s.userId}` : `name:${(s.displayName ?? "").toLowerCase()}`;
  return ctx.redactor.people.personByName(s.displayName, key, s.role);
}

function mapListItem(ctx: AppContext, m: MessageListItem): MessageDto {
  return compact({
    messageId: m.id,
    sent: at(m.sentDateTime),
    subject: ctx.redactor.title(m.subject, 300),
    preview: ctx.redactor.optional(m.contentPreview, 300),
    from: senderPerson(ctx, m.sender),
    read: m.isMessageRead,
    hasAttachments: m.hasAttachments,
    requiresConfirmation: m.requestConfirmation ? true : undefined,
  }) as MessageDto;
}

export const listMessagesInput = {
  limit: z.number().int().min(1).max(100).default(20),
  unreadOnly: z.boolean().default(false),
  search: z.string().max(100).optional().describe("Search text (passed to WebUntis)"),
};
type ListMessagesArgs = { limit?: number; unreadOnly?: boolean; search?: string };

export async function listMessages(ctx: AppContext, args: ListMessagesArgs) {
  const res = await ctx.untis.messages(args.search);
  // Register all senders first, so that their names are recognised in subjects/previews
  const all = [...(res.incomingMessages ?? []), ...(res.readConfirmationMessages ?? [])];
  for (const m of all) senderPerson(ctx, m.sender);
  let list = all.map((m) => mapListItem(ctx, m));
  const seen = new Set<number>();
  list = list.filter((m) => !seen.has(m.messageId) && seen.add(m.messageId));
  list.sort((a, b) => (b.sent ?? "").localeCompare(a.sent ?? ""));
  const unread = list.filter((m) => m.read === false).length;
  if (args.unreadOnly) list = list.filter((m) => m.read === false);
  const limit = args.limit ?? 20;
  return { messages: list.slice(0, limit), total: list.length, unread, hasMore: list.length > limit };
}

export function messageAttachments(d: MessageDetail): MessageAttachment[] {
  const list = [...(d.storageAttachments ?? []), ...(d.attachments ?? [])];
  if (d.blobAttachment) list.push({ ...d.blobAttachment, src: "blob" });
  return list;
}

export type MessageDetailDto = MessageDto & { text: string; attachments?: FileRefDto[]; recipients?: number };

export async function getMessage(ctx: AppContext, args: { messageId: number }): Promise<MessageDetailDto> {
  const d = await ctx.untis.message(args.messageId);
  senderPerson(ctx, d.sender);
  const attachments = messageAttachments(d).map((a, n) => fileRefDto(ctx, { kind: "m", messageId: args.messageId, n }, a.name));
  return compact({
    ...mapListItem(ctx, { ...d, id: d.id ?? args.messageId }),
    text: ctx.redactor.text(d.content, 20_000),
    attachments: attachments.length ? attachments : undefined,
    recipients: d.recipients?.length || undefined,
  }) as MessageDetailDto;
}

export const messagesOfDayInput = { date: dateInput("Day (default: today)") };
export type MessageOfDayDto = { subject?: string; text: string; attachments?: FileRefDto[] };

export async function messagesOfDay(ctx: AppContext, args: { date?: string }) {
  const date = parseDateInput(args.date, "date") ?? ctx.today();
  const res = await ctx.untis.messagesOfDay(date);
  const items = (res.data?.messagesOfDay ?? []).map((m, n) => {
    const attachments = (m.attachments ?? []).map((a, k) => fileRefDto(ctx, { kind: "d", date, n, k }, a.name));
    return compact({
      subject: ctx.redactor.optional(m.subject, 300),
      text: ctx.redactor.text(m.text, 5_000),
      attachments: attachments.length ? attachments : undefined,
    }) as MessageOfDayDto;
  });
  return { date, items, total: items.length };
}

export function registerMessageTools(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "untis_list_messages",
    {
      title: "Messages",
      description:
        'Inbox of the WebUntis message centre ("Mitteilungen"), newest first: subject, preview, sender (teachers by last name, others as pseudonyms), read flag. Details via untis_get_message.',
      inputSchema: listMessagesInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_list_messages", async (args: ListMessagesArgs) => {
      const data = await listMessages(ctx, args);
      return ok(`${data.total} messages (${data.unread} unread).`, data);
    }),
  );

  server.registerTool(
    "untis_get_message",
    {
      title: "Message",
      description:
        "Full text and attachments (fileRef → untis_download_file) of one message. Note: WebUntis may mark the message as read when it is opened. Read confirmations are never sent by this server.",
      inputSchema: { messageId: z.number().int().positive() },
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_get_message", async (args: { messageId: number }) => {
      const data = await getMessage(ctx, args);
      return ok(`Message "${data.subject}".`, data);
    }),
  );

  server.registerTool(
    "untis_messages_of_day",
    {
      title: "Messages of the day",
      description: 'School-wide messages of the day ("Nachrichten des Tages") for a date (default: today).',
      inputSchema: messagesOfDayInput,
      annotations: READ_ONLY,
    },
    handler(ctx, "untis_messages_of_day", async (args: { date?: string }) => {
      const data = await messagesOfDay(ctx, args);
      return ok(`${data.total} messages of the day for ${data.date}.`, data);
    }),
  );
}

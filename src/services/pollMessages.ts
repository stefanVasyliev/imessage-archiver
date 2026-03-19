import type Database from "better-sqlite3";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface RawAttachmentRow {
  messageRowId: number;
  messageGuid: string | null;
  messageDate: number | null;
  text: string | null;
  isFromMe: number;
  attachmentRowId: number;
  attachmentFilename: string | null;
  attachmentMimeType: string | null;
  handleId: string | null;
  chatId: number;
  chatDisplayName: string | null;
}

export interface TextMessageRow {
  messageRowId: number;
  messageDate: number | null;
  text: string | null;
  isFromMe: number;
  handleId: string | null;
  chatId: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getNewAttachmentRows(
  db: Database.Database,
  lastProcessedMessageRowId: number,
): RawAttachmentRow[] {
  const query = db.prepare(`
    SELECT
      m.ROWID          AS messageRowId,
      m.guid           AS messageGuid,
      m.date           AS messageDate,
      m.text           AS text,
      m.is_from_me     AS isFromMe,
      a.ROWID          AS attachmentRowId,
      a.filename       AS attachmentFilename,
      a.mime_type      AS attachmentMimeType,
      h.id             AS handleId,
      c.ROWID          AS chatId,
      c.display_name   AS chatDisplayName
    FROM message m
    JOIN message_attachment_join maj
      ON maj.message_id = m.ROWID
    JOIN attachment a
      ON a.ROWID = maj.attachment_id
    JOIN chat_message_join cmj
      ON cmj.message_id = m.ROWID
    JOIN chat c
      ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h
      ON h.ROWID = m.handle_id
    WHERE
      m.ROWID > ?
      AND a.filename IS NOT NULL
      AND cmj.chat_id = ?
    ORDER BY m.ROWID ASC
  `);

  const rows = query.all(
    lastProcessedMessageRowId,
    env.TARGET_CHAT_ID,
  ) as RawAttachmentRow[];

  logger.debug(
    {
      targetChatId: env.TARGET_CHAT_ID,
      lastProcessedMessageRowId,
      count: rows.length,
    },
    "Fetched new attachment rows for target chat",
  );

  return rows;
}

/**
 * Returns text-only messages (no attachment) newer than `lastProcessedMessageRowId`.
 * These are scanned before attachments so that a user's "project mention" text
 * can populate the context store before their file uploads are processed.
 */
export function getNewTextMessages(
  db: Database.Database,
  lastProcessedMessageRowId: number,
): TextMessageRow[] {
  const query = db.prepare(`
    SELECT
      m.ROWID        AS messageRowId,
      m.date         AS messageDate,
      m.text         AS text,
      m.is_from_me   AS isFromMe,
      h.id           AS handleId,
      c.ROWID        AS chatId
    FROM message m
    JOIN chat_message_join cmj
      ON cmj.message_id = m.ROWID
    JOIN chat c
      ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h
      ON h.ROWID = m.handle_id
    LEFT JOIN message_attachment_join maj
      ON maj.message_id = m.ROWID
    WHERE
      m.ROWID > ?
      AND cmj.chat_id = ?
      AND maj.attachment_id IS NULL
      AND m.text IS NOT NULL
    ORDER BY m.ROWID ASC
  `);

  const rows = query.all(
    lastProcessedMessageRowId,
    env.TARGET_CHAT_ID,
  ) as TextMessageRow[];

  logger.debug(
    {
      targetChatId: env.TARGET_CHAT_ID,
      lastProcessedMessageRowId,
      count: rows.length,
    },
    "Fetched new text-only messages for target chat",
  );

  return rows;
}

/**
 * Returns the most recent `limit` text-only messages from the target chat,
 * with NO lower-bound ROWID filter. Used to seed project context from recent
 * chat history at the start of every poll cycle — ensures that project-defining
 * messages sent before the state pointer are not missed (e.g. after a restart,
 * or when an attachment advanced the pointer past a project text message).
 */
export function getRecentTextMessages(
  db: Database.Database,
  limit: number,
): TextMessageRow[] {
  const query = db.prepare(`
    SELECT
      m.ROWID        AS messageRowId,
      m.date         AS messageDate,
      m.text         AS text,
      m.is_from_me   AS isFromMe,
      h.id           AS handleId,
      c.ROWID        AS chatId
    FROM message m
    JOIN chat_message_join cmj
      ON cmj.message_id = m.ROWID
    JOIN chat c
      ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h
      ON h.ROWID = m.handle_id
    LEFT JOIN message_attachment_join maj
      ON maj.message_id = m.ROWID
    WHERE
      cmj.chat_id = ?
      AND maj.attachment_id IS NULL
      AND m.text IS NOT NULL
    ORDER BY m.ROWID DESC
    LIMIT ?
  `);

  const rows = query.all(env.TARGET_CHAT_ID, limit) as TextMessageRow[];

  logger.debug(
    { targetChatId: env.TARGET_CHAT_ID, limit, count: rows.length },
    "Fetched recent text messages for context seeding",
  );

  return rows;
}

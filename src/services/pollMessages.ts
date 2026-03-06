import type Database from "better-sqlite3";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface RawAttachmentRow {
  messageRowId: number;
  messageGuid: string | null;
  messageDate: number | null;
  text: string | null;
  isFromMe: number;
  attachmentRowId: number | null;
  attachmentFilename: string | null;
  attachmentMimeType: string | null;
  handleId: string | null;
  chatId: number;
}

export function getNewAttachmentRows(
  db: Database.Database,
  lastProcessedMessageRowId: number,
): RawAttachmentRow[] {
  const query = db.prepare(`
    SELECT
      m.ROWID AS messageRowId,
      m.guid AS messageGuid,
      m.date AS messageDate,
      m.text AS text,
      m.is_from_me AS isFromMe,
      a.ROWID AS attachmentRowId,
      a.filename AS attachmentFilename,
      a.mime_type AS attachmentMimeType,
      h.id AS handleId,
      cmj.chat_id AS chatId
    FROM chat_message_join AS cmj
    INNER JOIN message AS m
      ON m.ROWID = cmj.message_id
    LEFT JOIN handle AS h
      ON m.handle_id = h.ROWID
    LEFT JOIN message_attachment_join AS maj
      ON maj.message_id = m.ROWID
    LEFT JOIN attachment AS a
      ON a.ROWID = maj.attachment_id
    WHERE cmj.chat_id = ?
      AND m.ROWID > ?
      AND a.filename IS NOT NULL
    ORDER BY m.ROWID ASC
  `);

  const rows = query.all(
    env.TARGET_CHAT_ID,
    lastProcessedMessageRowId,
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

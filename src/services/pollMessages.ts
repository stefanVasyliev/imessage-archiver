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
  chatDisplayName: string | null;
  projectName: string | null;
}

function extractProjectName(chatDisplayName: string | null): string | null {
  if (!chatDisplayName) {
    return null;
  }

  const chatName = chatDisplayName.trim();
  const prefix = env.TARGET_CHAT_PREFIX.trim();

  if (!chatName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null;
  }

  const rawProjectName = chatName
    .slice(prefix.length)
    .replace(/^[:\-\s]+/, "")
    .trim();

  return rawProjectName.length > 0 ? rawProjectName : null;
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
      c.ROWID AS chatId,
      c.display_name AS chatDisplayName
    FROM chat_message_join AS cmj
    INNER JOIN chat AS c
      ON c.ROWID = cmj.chat_id
    INNER JOIN message AS m
      ON m.ROWID = cmj.message_id
    LEFT JOIN handle AS h
      ON m.handle_id = h.ROWID
    LEFT JOIN message_attachment_join AS maj
      ON maj.message_id = m.ROWID
    LEFT JOIN attachment AS a
      ON a.ROWID = maj.attachment_id
    WHERE
      m.ROWID > ?
      AND a.filename IS NOT NULL
      AND c.display_name IS NOT NULL
      AND c.display_name LIKE ?
    ORDER BY m.ROWID ASC
  `);

  const chatPrefixPattern = `${env.TARGET_CHAT_PREFIX}%`;

  const rawRows = query.all(
    lastProcessedMessageRowId,
    chatPrefixPattern,
  ) as Array<Omit<RawAttachmentRow, "projectName">>;

  const rows: RawAttachmentRow[] = rawRows
    .map((row) => ({
      ...row,
      projectName: extractProjectName(row.chatDisplayName),
    }))
    .filter((row) => row.projectName !== null);

  logger.debug(
    {
      targetChatPrefix: env.TARGET_CHAT_PREFIX,
      lastProcessedMessageRowId,
      count: rows.length,
    },
    "Fetched new attachment rows for AIC chats",
  );

  return rows;
}

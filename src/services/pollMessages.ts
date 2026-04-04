import type Database from "better-sqlite3";
import { env } from "../config/env.js";

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

  return rows;
}

// ---------------------------------------------------------------------------
// Text quality helpers
// ---------------------------------------------------------------------------

const JUNK_EXACT = new Set([
  "NSAttributedString",
  "NSString",
  "NSDictionary",
  "NSNumber",
  "NSObject",
  "streamtyped",
  "￼",
]);

// iMessage reaction phrases produced by the system, not the user.
const REACTION_PREFIXES = [
  "loved an ",
  "liked an ",
  "disliked an ",
  "laughed at an ",
  "emphasized an ",
  "questioned an ",
  "loved a ",
  "liked a ",
  "disliked a ",
  "laughed at a ",
  "emphasized a ",
  "questioned a ",
];

/**
 * Returns true only for text that looks like a real human message.
 * Rejects:
 *  - framework class names (NSAttributedString, NSObject, …)
 *  - internal iMessage keys (__kIM…)
 *  - reaction phrases ("Loved an image", …)
 *  - attachment placeholder char (￼)
 *  - junk patterns like "iI", "Ii"
 *  - strings with no letters or digits
 *  - single-character strings
 */
export function isMeaningfulHumanText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length < 2) return false;
  if (!/[a-zA-Z0-9]/.test(t)) return false;
  if (JUNK_EXACT.has(t)) return false;
  if (t.includes("__kIM")) return false;
  if (/^[iI]+$/.test(t)) return false; // "iI", "Ii", "iIiI" etc.
  const lower = t.toLowerCase();
  for (const prefix of REACTION_PREFIXES) {
    if (lower.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Returns up to `limit` non-trivial text messages sent by the same sender
 * (identified by senderId = getSenderId output) in `chatId`, with ROWID
 * strictly less than `beforeRowId`.  Results are newest-first — callers
 * that want oldest-first should reverse the array.
 */
export function getRecentTextMessagesBySenderBefore(
  db: Database.Database,
  params: {
    senderId: string;
    chatId: number;
    beforeRowId: number;
    limit: number;
  },
): TextMessageRow[] {
  const isMe = params.senderId === "momo";

  const rows = isMe
    ? (db
        .prepare(
          `
          SELECT
            m.ROWID        AS messageRowId,
            m.date         AS messageDate,
            m.text         AS text,
            m.is_from_me   AS isFromMe,
            h.id           AS handleId,
            c.ROWID        AS chatId
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          JOIN chat c ON c.ROWID = cmj.chat_id
          LEFT JOIN handle h ON h.ROWID = m.handle_id
          LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
          WHERE
            cmj.chat_id = ?
            AND m.ROWID < ?
            AND maj.attachment_id IS NULL
            AND m.text IS NOT NULL
            AND m.is_from_me = 1
          ORDER BY m.ROWID DESC
          LIMIT ?
        `,
        )
        .all(
          params.chatId,
          params.beforeRowId,
          params.limit,
        ) as TextMessageRow[])
    : (db
        .prepare(
          `
          SELECT
            m.ROWID        AS messageRowId,
            m.date         AS messageDate,
            m.text         AS text,
            m.is_from_me   AS isFromMe,
            h.id           AS handleId,
            c.ROWID        AS chatId
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          JOIN chat c ON c.ROWID = cmj.chat_id
          LEFT JOIN handle h ON h.ROWID = m.handle_id
          LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
          WHERE
            cmj.chat_id = ?
            AND m.ROWID < ?
            AND maj.attachment_id IS NULL
            AND m.text IS NOT NULL
            AND m.is_from_me = 0
            AND h.id = ?
          ORDER BY m.ROWID DESC
          LIMIT ?
        `,
        )
        .all(
          params.chatId,
          params.beforeRowId,
          params.senderId,
          params.limit,
        ) as TextMessageRow[]);

  return rows.filter((r) => r.text && isMeaningfulHumanText(r.text));
}

/**
 * Returns up to `limit` text-only messages from any participant in `chatId`
 * with ROWID strictly less than `beforeRowId`, sorted oldest-first.
 *
 * Excludes:
 *   - messages with attachments (LEFT JOIN anti-join on message_attachment_join)
 *   - NULL or whitespace-only text
 *
 * Does NOT apply the trivial-message filter — callers receive the raw history
 * so AI context is as complete as possible.
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

  return rows;
}

/**
 * Returns the text of the most recent meaningful message sent by the same
 * person as the attachment, before the attachment's ROWID.
 *
 * Uses `isFromMe` and `handleId` directly (avoids the "momo" alias that was
 * removed from getSenderId). Fetches up to 20 candidate rows and walks them
 * newest-first, trying m.text then m.attributedBody, until a meaningful one
 * is found.  Returns null if nothing useful is found.
 */
export function getLastMeaningfulTextMessageBySenderBefore(
  db: Database.Database,
  params: {
    isFromMe: number;
    handleId: string | null;
    chatId: number;
    beforeRowId: number;
  },
): string | null {
  type CandidateRow = { text: string | null; attributedBody: Buffer | null };

  const rows: CandidateRow[] =
    params.isFromMe === 1
      ? (db
          .prepare(
            `
            SELECT m.text, m.attributedBody
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            WHERE
              cmj.chat_id = ?
              AND m.ROWID < ?
              AND m.is_from_me = 1
            ORDER BY m.ROWID DESC
            LIMIT 20
          `,
          )
          .all(params.chatId, params.beforeRowId) as CandidateRow[])
      : (db
          .prepare(
            `
            SELECT m.text, m.attributedBody
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE
              cmj.chat_id = ?
              AND m.ROWID < ?
              AND m.is_from_me = 0
              AND h.id = ?
            ORDER BY m.ROWID DESC
            LIMIT 20
          `,
          )
          .all(
            params.chatId,
            params.beforeRowId,
            params.handleId ?? "",
          ) as CandidateRow[]);

  // Two-pass: prefer the most recent short text (≤ 60 chars, ≥ 4 chars) as
  // it is most likely a project name/marker rather than conversational text.
  // Fall back to the most recent meaningful text of any length.
  let longFallback: string | null = null;

  for (const row of rows) {
    const text =
      typeof row.text === "string" && isMeaningfulHumanText(row.text)
        ? row.text.trim()
        : extractTextFromAttributedBody(row.attributedBody);

    if (text === null) continue;

    if (text.length >= 4 && text.length <= 60) {
      return text;
    }

    if (longFallback === null) {
      longFallback = text;
    }
  }

  return longFallback;
}

/**
 * Returns the most recent `limit` text-only messages from the target chat,
 * with NO lower-bound ROWID filter. Used to seed project context from recent
 * chat history at the start of every poll cycle — ensures that project-defining
 * messages sent before the state pointer are not missed (e.g. after a restart,
 * or when an attachment advanced the pointer past a project text message).
 */
function extractTextFromAttributedBody(
  attributedBody: Buffer | null | undefined,
): string | null {
  if (!attributedBody || attributedBody.length === 0) return null;

  const decoded = attributedBody.toString("utf8");

  // Extract printable ASCII segments; allow common punctuation in messages.
  const matches =
    decoded.match(/[A-Za-z0-9][A-Za-z0-9 .,_\-:/!?'"]{1,200}/g) ?? [];

  for (const part of matches) {
    const s = part.trim();
    if (isMeaningfulHumanText(s)) return s;
  }

  return null;
}

export function getRecentTextMessagesByChatBefore(
  db: Database.Database,
  params: { chatId: number; beforeRowId: number; limit: number },
): TextMessageRow[] {
  const rows = db
    .prepare(
      `
    SELECT
      m.ROWID AS messageRowId,
      m.date AS messageDate,
      m.text AS text,
      m.attributedBody AS attributedBody,
      m.is_from_me AS isFromMe,
      h.id AS handleId,
      cmj.chat_id AS chatId,
      maj.attachment_id AS attachmentId
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
    WHERE
      cmj.chat_id = ?
      AND m.ROWID < ?
    ORDER BY m.ROWID DESC
    LIMIT ?
  `,
    )
    .all(params.chatId, params.beforeRowId, params.limit * 4) as Array<
    TextMessageRow & {
      attributedBody?: Buffer | null;
      attachmentId?: number | null;
    }
  >;

  const normalized = rows
    .map((row) => {
      const fromText =
        typeof row.text === "string" && isMeaningfulHumanText(row.text)
          ? row.text.trim()
          : null;
      const resolvedText =
        fromText ?? extractTextFromAttributedBody(row.attributedBody);

      return {
        ...row,
        text: resolvedText ?? null,
      };
    })
    .filter((row) => row.text !== null && isMeaningfulHumanText(row.text))
    .slice(0, params.limit)
    .reverse();

  return normalized;
}

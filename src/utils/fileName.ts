import * as path from "node:path";
import type { RawAttachmentRow } from "../services/pollMessages.js";

function safeIsoForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function buildTemporaryFileName(row: RawAttachmentRow): string {
  const originalExtension = row.attachmentFilename
    ? path.extname(row.attachmentFilename)
    : "";

  const timestamp = safeIsoForFile(new Date());

  return (
    [
      `chat-${row.chatId}`,
      `msg-${row.messageRowId}`,
      row.attachmentRowId ? `att-${row.attachmentRowId}` : "att-unknown",
      timestamp,
    ].join("_") + originalExtension
  );
}

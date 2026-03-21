import fs from "fs-extra";
import * as os from "node:os";
import * as path from "node:path";
import { appPaths } from "../utils/filePaths.js";
import { buildTemporaryFileName } from "../utils/fileName.js";
import { logger } from "../utils/logger.js";
import type { RawAttachmentRow } from "./pollMessages.js";

export interface ExtractedAttachment {
  sourcePath: string;
  destinationPath: string;
  fileName: string;
}

function normalizeAppleAttachmentPath(inputPath: string): string {
  let normalizedPath = inputPath.replace(/^file:\/\//, "");

  if (normalizedPath.startsWith("~/")) {
    normalizedPath = path.join(os.homedir(), normalizedPath.slice(2));
  }

  return normalizedPath;
}

export async function extractAttachment(
  row: RawAttachmentRow,
): Promise<ExtractedAttachment | null> {
  if (!row.attachmentFilename) {
    return null;
  }

  const sourcePath = normalizeAppleAttachmentPath(row.attachmentFilename);
  const fileName = buildTemporaryFileName(row);
  const destinationPath = path.join(appPaths.tempIncoming, fileName);

  const sourceExists = await fs.pathExists(sourcePath);

  if (!sourceExists) {
    logger.error(
      {
        operation: "extractAttachment",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        chatId: row.chatId,
        handleId: row.handleId,
        attachmentFilename: row.attachmentFilename,
        sourcePath,
      },
      "Attachment source file does not exist — cannot extract",
    );
    return null;
  }

  await fs.ensureDir(appPaths.tempIncoming);

  try {
    await fs.copy(sourcePath, destinationPath, { overwrite: true });
  } catch (err: unknown) {
    logger.error(
      {
        error: err,
        operation: "extractAttachment",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        chatId: row.chatId,
        sourcePath,
        destinationPath,
      },
      "Failed to copy attachment to staging directory",
    );
    return null;
  }

  return {
    sourcePath,
    destinationPath,
    fileName,
  };
}

import fs from "fs-extra";
import * as path from "node:path";
import * as os from "node:os";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";
import { buildTemporaryFileName } from "../utils/fileName.js";
import type { RawAttachmentRow } from "./pollMessages.js";

export interface ExtractedAttachment {
  sourcePath: string;
  destinationPath: string;
  fileName: string;
}

function normalizeAppleAttachmentPath(inputPath: string): string {
  let normalizedPath = inputPath.replace(/^file:\/\//, "");

  // Expand "~/" into the current user's home directory.
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

  logger.info(
    { rawAttachmentFilename: row.attachmentFilename },
    "Raw attachment filename from chat.db",
  );

  const sourcePath = normalizeAppleAttachmentPath(row.attachmentFilename);
  const fileName = buildTemporaryFileName(row);
  const destinationPath = path.join(appPaths.incoming, fileName);

  logger.info({ sourcePath }, "Normalized attachment source path");

  const sourceExists = await fs.pathExists(sourcePath);

  logger.info({ sourcePath, sourceExists }, "Checked attachment source path");

  if (!sourceExists) {
    logger.warn({ sourcePath }, "Attachment source file does not exist");
    return null;
  }

  await fs.ensureDir(appPaths.incoming);

  logger.info({ sourcePath, destinationPath }, "About to copy attachment");

  await fs.copy(sourcePath, destinationPath, { overwrite: true });

  logger.info({ destinationPath }, "Attachment copied into incoming directory");

  return {
    sourcePath,
    destinationPath,
    fileName,
  };
}

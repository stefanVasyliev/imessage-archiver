import fs from "fs-extra";
import * as path from "node:path";
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
  return inputPath.replace(/^file:\/\//, "");
}

export async function extractAttachment(
  row: RawAttachmentRow,
): Promise<ExtractedAttachment | null> {
  if (!row.attachmentFilename) {
    return null;
  }

  const sourcePath = normalizeAppleAttachmentPath(row.attachmentFilename);
  const fileName = buildTemporaryFileName(row);
  const destinationPath = path.join(appPaths.incoming, fileName);

  const sourceExists = await fs.pathExists(sourcePath);
  if (!sourceExists) {
    logger.warn({ sourcePath }, "Attachment source file does not exist");
    return null;
  }

  await fs.ensureDir(appPaths.incoming);
  await fs.copy(sourcePath, destinationPath, { overwrite: true });

  logger.info(
    {
      sourcePath,
      destinationPath,
      fileName,
    },
    "Attachment copied into incoming directory",
  );

  return {
    sourcePath,
    destinationPath,
    fileName,
  };
}
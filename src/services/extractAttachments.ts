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
    logger.warn({ sourcePath }, "Attachment source file does not exist");
    return null;
  }

  await fs.ensureDir(appPaths.tempIncoming);


  await fs.copy(sourcePath, destinationPath, { overwrite: true });

  return {
    sourcePath,
    destinationPath,
    fileName,
  };
}

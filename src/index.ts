import fs from "fs-extra";
import * as path from "node:path";
import { env } from "./config/env.js";
import { openChatDb } from "./db/chatDb.js";
import { readState, writeState } from "./db/stateStore.js";
import { classifyAttachment } from "./services/aiClassifier.js";
import { moveToDirectory } from "./services/archiveFile.js";
import { extractAttachment } from "./services/extractAttachments.js";
import { getNewAttachmentRows } from "./services/pollMessages.js";
import { generateWeeklyReport } from "./services/weeklyReport.js";
import { createDuplicateAlert } from "./services/duplicateAlert.js";
import { createMetadataLog } from "./services/metadataLog.js";
import { buildFinalNaming } from "./utils/finalNaming.js";
import { getFileCategory } from "./utils/fileType.js";
import { appPaths } from "./utils/filePaths.js";
import { logger } from "./utils/logger.js";
import {
  ensureProjectStructure,
  normalizeProjectName,
} from "./utils/projectFolders.js";
import { detectDuplicate } from "./services/duplicateDetector.js";

const metadataLog = createMetadataLog("./logs/processed.jsonl");
const duplicateAlert = createDuplicateAlert(env.RESEND_API_KEY);

async function ensureDirectories(): Promise<void> {
  await Promise.all([
    fs.ensureDir(appPaths.root),
    fs.ensureDir(appPaths.weeklyReportDir),
    fs.ensureDir("./logs"),
  ]);
}

async function processNewMessages(): Promise<void> {
  const db = openChatDb();
  const state = await readState();
  const rows = getNewAttachmentRows(db, state.lastProcessedMessageRowId);

  let newestRowId = state.lastProcessedMessageRowId;

  for (const row of rows) {
    newestRowId = Math.max(newestRowId, row.messageRowId);

    if (!row.projectName) {
      logger.warn(
        {
          messageRowId: row.messageRowId,
          chatDisplayName: row.chatDisplayName,
        },
        "Skipping message because project name could not be resolved",
      );
      continue;
    }

    await ensureProjectStructure(row.projectName);

    const extracted = await extractAttachment(row);
    if (!extracted) continue;

    const category = getFileCategory(extracted.destinationPath);

    if (category === "unknown") {
      logger.warn(
        {
          messageRowId: row.messageRowId,
          sourcePath: extracted.destinationPath,
        },
        "Unsupported file type skipped",
      );
      continue;
    }

    // 🔥 AI CLASSIFICATION
    const classification = await classifyAttachment({
      filePath: extracted.destinationPath,
      category,
      messageText: row.text,
      originalFilename: row.attachmentFilename,
      projectName: row.projectName,
    });

    // 🔥 NAMING
    const naming = buildFinalNaming({
      row,
      category,
      classification,
      originalPath: extracted.destinationPath,
    });

    const normalizedProjectName = normalizeProjectName(row.projectName);
    const projectRoot = path.join(appPaths.root, normalizedProjectName);

    const targetDirectory =
      naming.rootFolder === "Renders" || naming.rootFolder === "Final"
        ? path.join(projectRoot, naming.rootFolder)
        : path.join(
            projectRoot,
            naming.rootFolder,
            naming.phaseFolder ?? "Finish",
          );

    // 🔥 DUPLICATE DETECTION
    const duplicate = await detectDuplicate({
      filePath: extracted.destinationPath,
      category,
    });

    let finalPath: string;

    if (duplicate.isDuplicate) {
      const duplicateDir = path.join(appPaths.root, "duplicates");

      finalPath = await moveToDirectory(
        extracted.destinationPath,
        duplicateDir,
        naming.fileName,
      );

      logger.warn(
        {
          file: naming.fileName,
          duplicateType: duplicate.duplicateType,
          matchedFilePath: duplicate.matchedFilePath,
          distance: duplicate.distance,
        },
        "Duplicate detected",
      );

      if (duplicate.duplicateType === "exact") {
        if (duplicate.duplicateType === "exact") {
          await duplicateAlert.send({
            projectName: row.projectName,
            fileName: naming.fileName,
            duplicateType: duplicate.duplicateType,
            ...(duplicate.matchedFilePath !== undefined
              ? { matchedPath: duplicate.matchedFilePath }
              : {}),
          });
        }
      }
    } else {
      finalPath = await moveToDirectory(
        extracted.destinationPath,
        targetDirectory,
        naming.fileName,
      );
    }

    // 🔥 METADATA LOG
    await metadataLog.write({
      processedAtIso: new Date().toISOString(),
      messageRowId: row.messageRowId,
      projectName: row.projectName,
      fileName: naming.fileName,
      relativePath: finalPath,
      rootFolder: naming.rootFolder,
      ...(naming.phaseFolder !== undefined
        ? { phase: naming.phaseFolder }
        : {}),
      category,
      confidence: classification.confidence ?? 0,
      isDuplicate: duplicate.isDuplicate,
      ...(duplicate.duplicateType !== undefined
        ? { duplicateType: duplicate.duplicateType }
        : {}),
      ...(duplicate.matchedFilePath !== undefined
        ? { duplicateMatchedPath: duplicate.matchedFilePath }
        : {}),
      classificationSource: "ai",
    });

    logger.info(
      {
        messageRowId: row.messageRowId,
        finalPath,
      },
      "Attachment processed",
    );
  }

  await writeState({ lastProcessedMessageRowId: newestRowId });
  db.close();
}

async function main(): Promise<void> {
  logger.info(
    {
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
    },
    "Starting archiver",
  );

  await ensureDirectories();

  generateWeeklyReport(appPaths.processedLogFile);

  await processNewMessages();

  setInterval(() => {
    void processNewMessages().catch((error: unknown) => {
      logger.error({ error }, "Polling failed");
    });
  }, env.POLL_INTERVAL_SECONDS * 1000);
}

void main().catch((error: unknown) => {
  logger.fatal({ error }, "App failed to start");
  process.exit(1);
});

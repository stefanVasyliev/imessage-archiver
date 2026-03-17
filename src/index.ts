import { schedule } from "node-cron";
import fs from "fs-extra";
import * as path from "node:path";
import { env } from "./config/env.js";
import { openChatDb } from "./db/chatDb.js";
import { readState, writeState } from "./db/stateStore.js";
import { classifyAttachment } from "./services/aiClassifier.js";
import { moveToDirectory } from "./services/archiveFile.js";
import { createDuplicateAlert } from "./services/duplicateAlert.js";
import { detectDuplicate } from "./services/duplicateDetector.js";
import { extractAttachment } from "./services/extractAttachments.js";
import { createMetadataLog } from "./services/metadataLog.js";
import { getNewAttachmentRows } from "./services/pollMessages.js";
import {
  generateWeeklyReport,
  sendWeeklyReportEmail,
} from "./services/weeklyReport.js";
import { buildFinalNaming } from "./utils/finalNaming.js";
import { getFileCategory } from "./utils/fileType.js";
import { appPaths } from "./utils/filePaths.js";
import { logger } from "./utils/logger.js";
import {
  ensureProjectStructure,
  normalizeProjectName,
} from "./utils/projectFolders.js";

const metadataLog = createMetadataLog(appPaths.processedLogFile);
const duplicateAlert = createDuplicateAlert(env.RESEND_API_KEY);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function ensureDirectories(): Promise<void> {
  await Promise.all([
    fs.ensureDir(appPaths.root),
    fs.ensureDir(appPaths.weeklyReportDir),
    fs.ensureDir(appPaths.logsDir),
    fs.ensureDir(appPaths.duplicatesDir),
    fs.ensureDir(appPaths.tempIncoming),
  ]);
}

// ---------------------------------------------------------------------------
// Main polling loop
// ---------------------------------------------------------------------------

async function processNewMessages(): Promise<void> {
  const db = openChatDb();
  const state = await readState();
  const rows = getNewAttachmentRows(db, state.lastProcessedMessageRowId);

  let newestRowId = state.lastProcessedMessageRowId;

  for (const row of rows) {
    newestRowId = Math.max(newestRowId, row.messageRowId);

    if (!row.projectName) {
      logger.warn(
        { messageRowId: row.messageRowId, chatDisplayName: row.chatDisplayName },
        "Skipping message — project name could not be resolved",
      );
      continue;
    }

    try {
      await processAttachment(row.projectName, row);
    } catch (error: unknown) {
      logger.error(
        { error, messageRowId: row.messageRowId },
        "Failed to process attachment — skipping",
      );
    }
  }

  await writeState({ lastProcessedMessageRowId: newestRowId });
  db.close();
}

async function processAttachment(
  projectName: string,
  row: Awaited<ReturnType<typeof getNewAttachmentRows>>[number],
): Promise<void> {
  await ensureProjectStructure(projectName);

  const extracted = await extractAttachment(row);
  if (!extracted) return;

  const category = getFileCategory(extracted.destinationPath);

  if (category === "unknown") {
    logger.warn(
      { messageRowId: row.messageRowId, sourcePath: extracted.destinationPath },
      "Unsupported file type — skipping",
    );
    return;
  }

  const classification = await classifyAttachment({
    filePath: extracted.destinationPath,
    category,
    messageText: row.text,
    originalFilename: row.attachmentFilename,
    projectName,
  });

  const naming = buildFinalNaming({
    row,
    category,
    classification,
    originalPath: extracted.destinationPath,
  });

  const projectRoot = path.join(appPaths.root, normalizeProjectName(projectName));
  const targetDirectory =
    naming.rootFolder === "Renders" || naming.rootFolder === "Final"
      ? path.join(projectRoot, naming.rootFolder)
      : path.join(projectRoot, naming.rootFolder, naming.phaseFolder ?? "Finish");

  const duplicate = await detectDuplicate({
    filePath: extracted.destinationPath,
    category,
  });

  let finalPath: string;

  if (duplicate.isDuplicate) {
    finalPath = await moveToDirectory(
      extracted.destinationPath,
      appPaths.duplicatesDir,
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
      await duplicateAlert.send({
        projectName,
        fileName: naming.fileName,
        duplicateType: duplicate.duplicateType,
        ...(duplicate.matchedFilePath !== undefined
          ? { matchedPath: duplicate.matchedFilePath }
          : {}),
      });
    }
  } else {
    finalPath = await moveToDirectory(
      extracted.destinationPath,
      targetDirectory,
      naming.fileName,
    );
  }

  await metadataLog.write({
    processedAtIso: new Date().toISOString(),
    messageRowId: row.messageRowId,
    projectName,
    fileName: naming.fileName,
    relativePath: finalPath,
    rootFolder: naming.rootFolder,
    ...(naming.phaseFolder !== undefined ? { phase: naming.phaseFolder } : {}),
    category,
    confidence: classification.confidence,
    isDuplicate: duplicate.isDuplicate,
    ...(duplicate.duplicateType !== undefined
      ? { duplicateType: duplicate.duplicateType }
      : {}),
    ...(duplicate.matchedFilePath !== undefined
      ? { duplicateMatchedPath: duplicate.matchedFilePath }
      : {}),
    classificationSource: classification.classificationSource === "ai" ? "ai" : "fallback",
  });

  logger.info({ messageRowId: row.messageRowId, finalPath }, "Attachment processed");
}

// ---------------------------------------------------------------------------
// Weekly report scheduler
// ---------------------------------------------------------------------------

function scheduleWeeklyReport(): void {
  // Every Sunday at 9:00 AM
  schedule("0 9 * * 0", () => {
    void generateWeeklyReport(appPaths.processedLogFile)
      .then(sendWeeklyReportEmail)
      .catch((error: unknown) => {
        logger.error({ error }, "Weekly report job failed");
      });
  });

  logger.info("Weekly report scheduled — Sundays at 09:00");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info({ pollIntervalSeconds: env.POLL_INTERVAL_SECONDS }, "Starting archiver");

  await ensureDirectories();
  scheduleWeeklyReport();
  await processNewMessages();

  setInterval(() => {
    void processNewMessages().catch((error: unknown) => {
      logger.error({ error }, "Polling cycle failed");
    });
  }, env.POLL_INTERVAL_SECONDS * 1000);
}

void main().catch((error: unknown) => {
  logger.fatal({ error }, "App failed to start");
  process.exit(1);
});

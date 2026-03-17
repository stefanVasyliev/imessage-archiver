import fs from "fs-extra";
import * as path from "node:path";
import { env } from "./config/env.js";
import { openChatDb } from "./db/chatDb.js";
import { readState, writeState } from "./db/stateStore.js";
import { classifyAttachment } from "./services/aiClassifier.js";
import { moveToDirectory } from "./services/archiveFile.js";
import { extractAttachment } from "./services/extractAttachments.js";
import { getNewAttachmentRows } from "./services/pollMessages.js";
import { scheduleWeeklyReport } from "./services/weeklyReport.js";
import { buildFinalNaming } from "./utils/finalNaming.js";
import { getFileCategory } from "./utils/fileType.js";
import { appPaths } from "./utils/filePaths.js";
import { logger } from "./utils/logger.js";
import {
  ensureProjectStructure,
  normalizeProjectName,
} from "./utils/projectFolders.js";

async function ensureDirectories(): Promise<void> {
  await Promise.all([
    fs.ensureDir(appPaths.root),
    fs.ensureDir(appPaths.weeklyReportDir),
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
        "Skipping message because project name could not be resolved from chat name",
      );
      continue;
    }

    await ensureProjectStructure(row.projectName);

    const extracted = await extractAttachment(row);

    if (!extracted) {
      continue;
    }

    const category = getFileCategory(extracted.destinationPath);

    logger.info(
      {
        messageRowId: row.messageRowId,
        fileName: extracted.fileName,
        category,
        projectName: row.projectName,
      },
      "Routing attachment by file category",
    );

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

    const classification = await classifyAttachment({
      filePath: extracted.destinationPath,
      category,
      messageText: row.text,
      originalFilename: row.attachmentFilename,
      projectName: row.projectName,
    });

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
        : path.join(projectRoot, naming.rootFolder, naming.phaseFolder);

    const finalPath = await moveToDirectory(
      extracted.destinationPath,
      targetDirectory,
      naming.fileName,
    );

    logger.info(
      {
        messageRowId: row.messageRowId,
        finalPath,
        category,
        classification,
      },
      "Attachment processed successfully",
    );
  }

  await writeState({ lastProcessedMessageRowId: newestRowId });
  db.close();
}

async function main(): Promise<void> {
  logger.info(
    {
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
      targetChatPrefix: env.TARGET_CHAT_PREFIX,
    },
    "Starting iMessage archiver",
  );

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
  logger.fatal({ error }, "Application failed to start");
  process.exit(1);
});

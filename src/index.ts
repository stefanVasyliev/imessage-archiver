import fs from "fs-extra";
import * as path from "node:path";
import { env } from "./config/env.js";
import { openChatDb } from "./db/chatDb.js";
import { readState, writeState } from "./db/stateStore.js";
import { classifyImage } from "./services/aiClassifier.js";
import { moveToDirectory } from "./services/archiveFile.js";
import { checkAndStoreDuplicate } from "./services/duplicateDetector.js";
import { extractAttachment } from "./services/extractAttachments.js";
import { getNewAttachmentRows } from "./services/pollMessages.js";
import { scheduleWeeklyReport } from "./services/weeklyReport.js";
import { buildFinalNaming } from "./utils/finalNaming.js";
import { getFileCategory } from "./utils/fileType.js";
import { appPaths } from "./utils/filePaths.js";
import { logger } from "./utils/logger.js";

async function ensureDirectories(): Promise<void> {
  await Promise.all([
    fs.ensureDir(appPaths.root),
    fs.ensureDir(appPaths.incoming),
    fs.ensureDir(appPaths.archive),
    fs.ensureDir(appPaths.duplicates),
    fs.ensureDir(appPaths.unsorted),
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
      },
      "Routing attachment by file category",
    );

    if (category === "image") {
      const duplicateResult = await checkAndStoreDuplicate(
        extracted.destinationPath,
      );

      if (duplicateResult.isDuplicate) {
        const finalPath = await moveToDirectory(
          extracted.destinationPath,
          appPaths.duplicates,
        );

        logger.info(
          {
            messageRowId: row.messageRowId,
            finalPath,
            isDuplicate: true,
          },
          "Image moved to duplicates",
        );

        continue;
      }

      const classification = await classifyImage(extracted.destinationPath);
      const naming = buildFinalNaming(
        row,
        category,
        classification,
        extracted.destinationPath,
      );

      const targetDirectory = naming.usedFallback
        ? path.join(appPaths.unsorted, naming.phaseFolder, naming.typeFolder)
        : path.join(
            appPaths.archive,
            naming.projectFolder,
            naming.phaseFolder,
            naming.typeFolder,
          );

      const finalPath = await moveToDirectory(
        extracted.destinationPath,
        targetDirectory,
        naming.fileName,
      );

      logger.info(
        {
          messageRowId: row.messageRowId,
          finalPath,
          classification,
          usedFallback: naming.usedFallback,
        },
        "Image processed successfully",
      );

      continue;
    }

    if (category === "pdf" || category === "video") {
      const naming = buildFinalNaming(
        row,
        category,
        null,
        extracted.destinationPath,
      );

      const targetDirectory =
        category === "pdf"
          ? path.join(
              appPaths.archive,
              "documents",
              "incoming",
              naming.typeFolder,
            )
          : path.join(
              appPaths.archive,
              "videos",
              "incoming",
              naming.typeFolder,
            );

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
        },
        `${category.toUpperCase()} archived successfully`,
      );

      continue;
    }

    const naming = buildFinalNaming(
      row,
      category,
      null,
      extracted.destinationPath,
    );

    const finalPath = await moveToDirectory(
      extracted.destinationPath,
      path.join(appPaths.unsorted, naming.phaseFolder, naming.typeFolder),
      naming.fileName,
    );

    logger.warn(
      {
        messageRowId: row.messageRowId,
        finalPath,
      },
      "Unsupported file type moved to unsorted",
    );
  }

  await writeState({
    lastProcessedMessageRowId: newestRowId,
  });

  db.close();
}

async function main(): Promise<void> {
  logger.info(
    {
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
    },
    "Starting iMessage archiver prototype",
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

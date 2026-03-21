import Database from "better-sqlite3";
import * as fsSync from "node:fs";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export function openChatDb(): Database.Database {
  const dbPath = env.MESSAGES_DB_PATH;

  try {
    const stat = fsSync.statSync(dbPath);
    logger.info(
      {
        operation: "openChatDb",
        dbPath,
        fileSizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        targetChatId: env.TARGET_CHAT_ID,
      },
      "Opening Messages DB",
    );
  } catch (err: unknown) {
    logger.error(
      { operation: "openChatDb", dbPath, error: err },
      "Messages DB file not found or not accessible — cannot open DB",
    );
    throw err;
  }

  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  logger.info(
    { operation: "openChatDb", dbPath },
    "Messages DB opened successfully",
  );

  return db;
}

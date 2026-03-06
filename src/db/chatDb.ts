import Database from "better-sqlite3";
import { env } from "../config/env.js";

export function openChatDb(): Database.Database {
  return new Database(env.MESSAGES_DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
}

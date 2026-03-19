import * as os from "node:os";
import * as path from "node:path";
import { env } from "../config/env.js";

export const appPaths = {
  root: env.APP_STORAGE_ROOT,
  hashesFile: path.join(env.APP_STORAGE_ROOT, "attachment_hashes.json"),
  tempIncoming: path.join(os.tmpdir(), "imessage-ai-archiver", "incoming"),
  stateFile: path.join(env.APP_STORAGE_ROOT, ".imessage-archiver-state.json"),
  weeklyReportDir: path.join(process.cwd(), "reports"),
  logsDir: path.join(env.APP_STORAGE_ROOT, "logs"),
  processedLogFile: path.join(env.APP_STORAGE_ROOT, "logs", "processed.jsonl"),
  activityLogFile: path.join(env.APP_STORAGE_ROOT, "logs", "activity.jsonl"),
  messageLogFile: path.join(env.APP_STORAGE_ROOT, "logs", "messages.jsonl"),
  reportLogFile: path.join(env.APP_STORAGE_ROOT, "logs", "reports.jsonl"),
  duplicatesDir: path.join(env.APP_STORAGE_ROOT, "duplicates"),
  manualReviewDir: path.join(env.APP_STORAGE_ROOT, "ManualReview"),
} as const;

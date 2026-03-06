import * as path from "node:path";
import { env } from "../config/env.js";

export const appPaths = {
  root: env.APP_STORAGE_ROOT,
  incoming: path.join(env.APP_STORAGE_ROOT, "incoming"),
  archive: path.join(env.APP_STORAGE_ROOT, "archive"),
  duplicates: path.join(env.APP_STORAGE_ROOT, "duplicates"),
  unsorted: path.join(env.APP_STORAGE_ROOT, "unsorted"),
  stateFile: path.join(env.APP_STORAGE_ROOT, "state.json"),
  hashesFile: path.join(env.APP_STORAGE_ROOT, "hashes.json"),
  weeklyReportDir: path.join(process.cwd(), "reports"),
} as const;

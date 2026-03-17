import * as os from "node:os";
import * as path from "node:path";
import { env } from "../config/env.js";

export const appPaths = {
  root: env.APP_STORAGE_ROOT,
  tempIncoming: path.join(os.tmpdir(), "imessage-ai-archiver", "incoming"),
  stateFile: path.join(env.APP_STORAGE_ROOT, ".imessage-archiver-state.json"),
  weeklyReportDir: path.join(process.cwd(), "reports"),
} as const;

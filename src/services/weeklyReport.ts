import fs from "fs-extra";
import * as path from "node:path";
import cron from "node-cron";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";

export async function generateWeeklyReport(): Promise<string> {
  await fs.ensureDir(appPaths.weeklyReportDir);

  const reportPath = path.join(
    appPaths.weeklyReportDir,
    `weekly-report-${new Date().toISOString().slice(0, 10)}.json`,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    note: "This is an MVP weekly report. More detailed summaries will be added later.",
  };

  await fs.writeJson(reportPath, report, { spaces: 2 });

  logger.info({ reportPath }, "Weekly report generated");

  return reportPath;
}

export function scheduleWeeklyReport(): void {
  /**
   * Every Monday at 08:00 local time.
   */
  cron.schedule("0 8 * * 1", async () => {
    try {
      await generateWeeklyReport();
    } catch (error) {
      logger.error({ error }, "Failed to generate weekly report");
    }
  });
}

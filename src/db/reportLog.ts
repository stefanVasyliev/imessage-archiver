import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ReportEvent {
  readonly ts: string;
  readonly periodStartIso: string;
  readonly totalFiles: number;
  readonly uniqueFiles: number;
  readonly duplicates: number;
  readonly manualReview: number;
  readonly affectedProjects: number;
  readonly recipientEmail: string;
  readonly success: boolean;
  readonly errorMessage?: string;
}

export interface ReportLog {
  write(event: ReportEvent): Promise<void>;
}

export function createReportLog(filePath: string): ReportLog {
  return {
    async write(event: ReportEvent): Promise<void> {
      const line = JSON.stringify(event) + "\n";
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, line, "utf8");
    },
  };
}

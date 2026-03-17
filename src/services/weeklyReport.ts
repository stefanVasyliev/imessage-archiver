import fs from "fs-extra";
import * as path from "node:path";
import type { ProcessedFileEvent } from "./metadataLog.js";

export interface WeeklyReportResult {
  readonly summary: {
    readonly total: number;
    readonly duplicates: number;
  };
  readonly byProject: readonly {
    readonly projectName: string;
    readonly total: number;
  }[];
}

export async function generateWeeklyReport(
  filePath: string,
): Promise<WeeklyReportResult> {
  await fs.ensureDir(path.dirname(filePath));

  const exists = await fs.pathExists(filePath);

  if (!exists) {
    return {
      summary: {
        total: 0,
        duplicates: 0,
      },
      byProject: [],
    };
  }

  const content = await fs.readFile(filePath, "utf8");

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      summary: {
        total: 0,
        duplicates: 0,
      },
      byProject: [],
    };
  }

  const events: ProcessedFileEvent[] = lines.map((line) =>
    JSON.parse(line),
  ) as ProcessedFileEvent[];

  const summary = {
    total: events.length,
    duplicates: events.filter((event) => event.isDuplicate).length,
  };

  const byProjectMap = new Map<string, number>();

  for (const event of events) {
    byProjectMap.set(
      event.projectName,
      (byProjectMap.get(event.projectName) ?? 0) + 1,
    );
  }

  const byProject = Array.from(byProjectMap.entries()).map(
    ([projectName, total]) => ({
      projectName,
      total,
    }),
  );

  return {
    summary,
    byProject,
  };
}

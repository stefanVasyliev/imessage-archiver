import fs from "fs-extra";
import * as path from "node:path";
import { z } from "zod";
import { Resend } from "resend";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { appPaths } from "../utils/filePaths.js";

// ---------------------------------------------------------------------------
// Log entry schema — mirrors ProcessedFileEvent, used for safe JSONL parsing
// ---------------------------------------------------------------------------

const logEntrySchema = z.object({
  processedAtIso: z.string(),
  messageRowId: z.number(),
  projectName: z.string(),
  fileName: z.string(),
  relativePath: z.string(),
  rootFolder: z.enum(["Photos", "Videos", "Renders", "Final"]),
  phase: z.enum(["Demo", "Framing", "Electrical", "Finish"]).optional(),
  category: z.enum(["image", "video", "pdf", "unknown"]),
  confidence: z.number(),
  isDuplicate: z.boolean(),
  duplicateType: z.enum(["exact", "perceptual"]).optional(),
  duplicateMatchedPath: z.string().optional(),
  classificationSource: z.enum(["ai", "fallback"]),
});

type LogEntry = z.infer<typeof logEntrySchema>;

// ---------------------------------------------------------------------------
// Public report shape
// ---------------------------------------------------------------------------

export interface WeeklyReportData {
  readonly generatedAtIso: string;
  readonly summary: {
    readonly total: number;
    readonly duplicates: number;
  };
  readonly byProject: readonly {
    readonly projectName: string;
    readonly total: number;
  }[];
  readonly byPhase: readonly {
    readonly phase: string;
    readonly total: number;
  }[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseLogLine(line: string): LogEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return logEntrySchema.parse(parsed);
  } catch {
    return null;
  }
}

async function readLogEntries(filePath: string): Promise<LogEntry[]> {
  const exists = await fs.pathExists(filePath);
  if (!exists) {
    return [];
  }

  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);

  const entries: LogEntry[] = [];
  for (const line of lines) {
    const entry = parseLogLine(line);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return entries;
}

function aggregateEntries(entries: LogEntry[], generatedAtIso: string): WeeklyReportData {
  const summary = {
    total: entries.length,
    duplicates: entries.filter((e) => e.isDuplicate).length,
  };

  const byProjectMap = new Map<string, number>();
  const byPhaseMap = new Map<string, number>();

  for (const entry of entries) {
    byProjectMap.set(
      entry.projectName,
      (byProjectMap.get(entry.projectName) ?? 0) + 1,
    );
    const phase = entry.phase ?? "Unknown";
    byPhaseMap.set(phase, (byPhaseMap.get(phase) ?? 0) + 1);
  }

  return {
    generatedAtIso,
    summary,
    byProject: Array.from(byProjectMap.entries()).map(([projectName, total]) => ({
      projectName,
      total,
    })),
    byPhase: Array.from(byPhaseMap.entries()).map(([phase, total]) => ({
      phase,
      total,
    })),
  };
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

export function buildWeeklyReportHtml(data: WeeklyReportData): string {
  const dateStr = new Date(data.generatedAtIso).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const projectRows =
    data.byProject.length > 0
      ? data.byProject
          .map((p) => `<tr><td>${p.projectName}</td><td>${p.total}</td></tr>`)
          .join("\n")
      : `<tr><td colspan="2">No data</td></tr>`;

  const phaseRows =
    data.byPhase.length > 0
      ? data.byPhase
          .map((p) => `<tr><td>${p.phase}</td><td>${p.total}</td></tr>`)
          .join("\n")
      : `<tr><td colspan="2">No data</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Archive Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #1a1a1a; padding: 32px; max-width: 700px; margin: 0 auto; }
    h1 { font-size: 22px; color: #0f172a; margin-bottom: 4px; }
    .subtitle { color: #64748b; font-size: 14px; margin-bottom: 32px; }
    h2 { font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-top: 28px; }
    ul { padding-left: 20px; line-height: 1.8; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 8px; font-size: 14px; }
    th { background: #f8fafc; text-align: left; padding: 10px 14px; border: 1px solid #e2e8f0; font-weight: 600; }
    td { padding: 10px 14px; border: 1px solid #e2e8f0; }
    tr:nth-child(even) td { background: #f8fafc; }
  </style>
</head>
<body>
  <h1>Weekly Archive Report</h1>
  <p class="subtitle">Generated on ${dateStr}</p>

  <h2>Summary</h2>
  <ul>
    <li>Total files processed: <strong>${data.summary.total}</strong></li>
    <li>Duplicates detected: <strong>${data.summary.duplicates}</strong></li>
  </ul>

  <h2>Files per Project</h2>
  <table>
    <thead><tr><th>Project</th><th>Files</th></tr></thead>
    <tbody>${projectRows}</tbody>
  </table>

  <h2>Files per Phase</h2>
  <table>
    <thead><tr><th>Phase</th><th>Files</th></tr></thead>
    <tbody>${phaseRows}</tbody>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateWeeklyReport(
  logFilePath: string,
): Promise<WeeklyReportData> {
  await fs.ensureDir(path.dirname(logFilePath));

  const entries = await readLogEntries(logFilePath);
  const data = aggregateEntries(entries, new Date().toISOString());

  await fs.ensureDir(appPaths.weeklyReportDir);
  const reportPath = path.join(
    appPaths.weeklyReportDir,
    `weekly-report-${data.generatedAtIso.slice(0, 10)}.html`,
  );
  await fs.writeFile(reportPath, buildWeeklyReportHtml(data), "utf8");

  logger.info(
    { reportPath, total: data.summary.total, duplicates: data.summary.duplicates },
    "Weekly report generated",
  );

  return data;
}

export async function sendWeeklyReportEmail(data: WeeklyReportData): Promise<void> {
  const from = env.REPORT_EMAIL_FROM;
  const to = env.REPORT_EMAIL_TO;

  if (!from || !to) {
    logger.warn(
      "REPORT_EMAIL_FROM or REPORT_EMAIL_TO not configured — skipping weekly email",
    );
    return;
  }

  const resend = new Resend(env.RESEND_API_KEY);

  await resend.emails.send({
    from,
    to: [to],
    subject: `Weekly Archive Report — ${new Date(data.generatedAtIso).toLocaleDateString()}`,
    html: buildWeeklyReportHtml(data),
  });

  logger.info({ to }, "Weekly report email sent");
}

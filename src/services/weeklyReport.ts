import fs from "fs-extra";
import * as path from "node:path";
import { z } from "zod";
import { Resend } from "resend";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { appPaths } from "../utils/filePaths.js";
import { createReportLog } from "../db/reportLog.js";

const reportLog = createReportLog(appPaths.reportLogFile);

// ---------------------------------------------------------------------------
// Schedule configuration
//
// TEST_MODE = true  → runs every minute, covers last 1 minute of data.
// TEST_MODE = false → runs Mondays at 06:00, covers the previous 7 days.
//
// To switch to production: set TEST_MODE = false.
// ---------------------------------------------------------------------------

export const TEST_MODE = true;

export const CRON_SCHEDULE = TEST_MODE
  ? "* * * * *" // every minute (test)
  : "0 6 * * 1"; // Mondays at 06:00 (production)

export function getReportPeriodStart(): Date {
  if (TEST_MODE) {
    return new Date(Date.now() - 18000 * 1000); // last 1 minute
  }
  const start = new Date();
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  return start;
}

// ---------------------------------------------------------------------------
// Log entry schema
// ---------------------------------------------------------------------------

const logEntrySchema = z.object({
  processedAtIso: z.string(),
  messageRowId: z.number(),
  senderId: z.string().default("unknown"),
  projectName: z.string(),
  // Added in v2 — optional for backward-compat with older log lines.
  projectResolutionSource: z.string().optional(),
  needsManualReview: z.boolean().optional(),
  originalFilename: z.string().optional(),
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
  // Future Dropbox / preview fields — not yet written by the archiver.
  // When populated, the report will render links and thumbnails automatically.
  dropboxPath: z.string().optional(),
  dropboxShareUrl: z.string().optional(),
  previewUrl: z.string().optional(),
});

type LogEntry = z.infer<typeof logEntrySchema>;

const MANUAL_REVIEW_SLUG = "ManualReview";

// ---------------------------------------------------------------------------
// Report data shape
// ---------------------------------------------------------------------------

interface ProjectStats {
  readonly projectName: string;
  readonly total: number;
  readonly duplicates: number;
  readonly manualReview: number;
}

export interface ReportData {
  readonly generatedAtIso: string;
  readonly periodStartIso: string;
  readonly summary: {
    readonly total: number;
    readonly unique: number;
    readonly duplicates: number;
    readonly affectedProjects: number;
    readonly manualReview: number;
  };
  readonly byProject: readonly ProjectStats[];
  readonly files: readonly LogEntry[];
  readonly duplicates: readonly LogEntry[];
  readonly manualReview: readonly LogEntry[];
}

// ---------------------------------------------------------------------------
// Log reading + filtering
// ---------------------------------------------------------------------------

function parseLogLine(line: string): LogEntry | null {
  try {
    return logEntrySchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}

async function readLogEntries(filePath: string): Promise<LogEntry[]> {
  const exists = await fs.pathExists(filePath);
  if (!exists) return [];
  const content = await fs.readFile(filePath, "utf8");
  const entries: LogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseLogLine(trimmed);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function buildReportData(
  entries: LogEntry[],
  periodStart: Date,
  generatedAtIso: string,
): ReportData {
  const sinceIso = periodStart.toISOString();
  const inPeriod = entries.filter((e) => e.processedAtIso >= sinceIso);

  const files = inPeriod.filter((e) => !e.isDuplicate);
  const duplicates = inPeriod.filter((e) => e.isDuplicate);
  const manualReview = inPeriod.filter(
    (e) => e.projectName === MANUAL_REVIEW_SLUG,
  );

  const affectedProjects = new Set(
    inPeriod
      .filter((e) => e.projectName !== MANUAL_REVIEW_SLUG)
      .map((e) => e.projectName),
  ).size;

  // Group all entries by project for the project summary table.
  const projectMap = new Map<
    string,
    { total: number; duplicates: number; manualReview: number }
  >();
  for (const e of inPeriod) {
    const cur = projectMap.get(e.projectName) ?? {
      total: 0,
      duplicates: 0,
      manualReview: 0,
    };
    projectMap.set(e.projectName, {
      total: cur.total + 1,
      duplicates: cur.duplicates + (e.isDuplicate ? 1 : 0),
      manualReview:
        cur.manualReview + (e.projectName === MANUAL_REVIEW_SLUG ? 1 : 0),
    });
  }

  const byProject: ProjectStats[] = Array.from(projectMap.entries())
    .filter(([name]) => name !== MANUAL_REVIEW_SLUG)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([projectName, stats]) => ({ projectName, ...stats }));

  return {
    generatedAtIso,
    periodStartIso: sinceIso,
    summary: {
      total: inPeriod.length,
      unique: files.length,
      duplicates: duplicates.length,
      affectedProjects,
      manualReview: manualReview.length,
    },
    byProject,
    files,
    duplicates,
    manualReview,
  };
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, Arial, sans-serif;
    font-size: 13px;
    color: #1e293b;
    background: #f8fafc;
    padding: 0;
  }
  .wrapper { max-width: 980px; margin: 0 auto; background: #fff; }
  /* Header */
  .header {
    background: #0f172a;
    color: #fff;
    padding: 28px 36px 24px;
  }
  .header-brand {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #64748b;
    margin-bottom: 6px;
  }
  .header-title { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 4px; }
  .header-period { font-size: 13px; color: #94a3b8; margin-top: 6px; }
  /* Content */
  .content { padding: 32px 36px; }
  /* Section */
  .section { margin-bottom: 36px; }
  .section-heading {
    font-size: 13px;
    font-weight: 700;
    color: #0f172a;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding-bottom: 8px;
    border-bottom: 2px solid #e2e8f0;
    margin-bottom: 14px;
  }
  /* Stats */
  .stats-grid { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-card {
    flex: 1;
    min-width: 120px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 16px 18px;
  }
  .stat-value { font-size: 30px; font-weight: 800; color: #0f172a; line-height: 1; }
  .stat-label { font-size: 11px; color: #64748b; margin-top: 5px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-card.accent .stat-value { color: #2563eb; }
  .stat-card.warn .stat-value { color: #d97706; }
  .stat-card.danger .stat-value { color: #dc2626; }
  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  thead th {
    background: #f1f5f9;
    color: #475569;
    font-weight: 600;
    text-align: left;
    padding: 9px 11px;
    border: 1px solid #e2e8f0;
    white-space: nowrap;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  tbody td {
    padding: 8px 11px;
    border: 1px solid #e2e8f0;
    vertical-align: top;
    color: #334155;
  }
  tbody tr:nth-child(even) td { background: #f8fafc; }
  tbody tr:hover td { background: #eff6ff; }
  /* Badges */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .badge-ai           { background: #dbeafe; color: #1d4ed8; }
  .badge-fallback     { background: #fef3c7; color: #92400e; }
  .badge-exact        { background: #fee2e2; color: #991b1b; }
  .badge-perceptual   { background: #fef3c7; color: #b45309; }
  .badge-image        { background: #f0fdf4; color: #15803d; }
  .badge-video        { background: #eff6ff; color: #1d4ed8; }
  .badge-pdf          { background: #fdf4ff; color: #7e22ce; }
  .badge-unknown      { background: #f1f5f9; color: #475569; }
  .badge-user-context { background: #f0fdf4; color: #15803d; }
  .badge-tag          { background: #eff6ff; color: #1e40af; }
  .badge-folder-match { background: #fdf4ff; color: #7e22ce; }
  .badge-chat-context { background: #ecfdf5; color: #065f46; }
  .badge-res-ai       { background: #dbeafe; color: #1d4ed8; }
  .badge-res-fallback { background: #fee2e2; color: #991b1b; }
  /* Path text */
  .path { font-family: monospace; font-size: 11px; color: #475569; word-break: break-all; }
  .link { color: #2563eb; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  /* Empty state */
  .empty {
    color: #94a3b8;
    font-style: italic;
    padding: 20px 0;
    text-align: center;
  }
  /* Footer */
  .footer {
    background: #f1f5f9;
    padding: 16px 36px;
    font-size: 11px;
    color: #94a3b8;
    border-top: 1px solid #e2e8f0;
  }
  /* Confidence bar */
  .conf { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .conf-pct { font-weight: 600; min-width: 30px; }
  .conf-bar-bg { width: 36px; height: 4px; background: #e2e8f0; border-radius: 2px; }
  .conf-bar { height: 4px; border-radius: 2px; background: #2563eb; }
`;

function esc(value: string | undefined | null): string {
  if (!value) return "<span style='color:#cbd5e1'>—</span>";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function confidence(n: number): string {
  const pct = Math.round(n * 100);
  const width = Math.max(1, Math.round((pct * 36) / 100));
  return `<span class="conf">
    <span class="conf-pct">${pct}%</span>
    <span class="conf-bar-bg"><span class="conf-bar" style="width:${width}px"></span></span>
  </span>`;
}

// Renders filename — as a link if dropboxShareUrl is available, plain text otherwise.
function renderFilename(entry: LogEntry): string {
  if (entry.dropboxShareUrl) {
    return `<a class="link" href="${esc(entry.dropboxShareUrl)}">${esc(entry.fileName)}</a>`;
  }
  return esc(entry.fileName);
}

// Renders optional thumbnail if previewUrl is available.
// When previewUrl is populated (future Dropbox integration), a small image
// will appear in the preview column automatically — no code changes needed.
function renderPreviewCell(entry: LogEntry): string {
  if (entry.previewUrl) {
    return `<img src="${esc(entry.previewUrl)}" width="56" height="42"
      style="object-fit:cover;border-radius:3px;display:block;" alt="" />`;
  }
  return `<span style="color:#cbd5e1;font-size:11px;">—</span>`;
}

function categoryBadge(cat: string): string {
  return `<span class="badge badge-${cat}">${cat}</span>`;
}

function sourceBadge(src: string): string {
  return `<span class="badge badge-${src}">${src}</span>`;
}

function resolutionBadge(src: string | undefined | null): string {
  if (!src) return `<span style="color:#cbd5e1">—</span>`;
  const cssKey =
    src === "ai" ? "res-ai" : src === "fallback" ? "res-fallback" : src;
  const label = src
    .replace("user-context", "context")
    .replace("folder-match", "folder");
  return `<span class="badge badge-${cssKey}">${label}</span>`;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildSummarySection(data: ReportData): string {
  const { summary } = data;
  return `
  <div class="section">
    <div class="section-heading">Summary</div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${summary.total}</div>
        <div class="stat-label">Total Processed</div>
      </div>
      <div class="stat-card accent">
        <div class="stat-value">${summary.unique}</div>
        <div class="stat-label">Unique Files</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${summary.affectedProjects}</div>
        <div class="stat-label">Projects</div>
      </div>
      <div class="stat-card warn">
        <div class="stat-value">${summary.duplicates}</div>
        <div class="stat-label">Duplicates</div>
      </div>
      <div class="stat-card danger">
        <div class="stat-value">${summary.manualReview}</div>
        <div class="stat-label">Manual Review</div>
      </div>
    </div>
  </div>`;
}

function buildProjectSection(byProject: readonly ProjectStats[]): string {
  if (byProject.length === 0) {
    return `<div class="section">
      <div class="section-heading">By Project</div>
      <p class="empty">No project activity in this period.</p>
    </div>`;
  }

  const rows = byProject
    .map(
      (p) => `
    <tr>
      <td><strong>${esc(p.projectName)}</strong></td>
      <td style="text-align:center">${p.total}</td>
      <td style="text-align:center">${p.total - p.duplicates}</td>
      <td style="text-align:center">${p.duplicates > 0 ? `<span style="color:#d97706;font-weight:600">${p.duplicates}</span>` : "0"}</td>
      <td style="text-align:center">${p.manualReview > 0 ? `<span style="color:#dc2626;font-weight:600">${p.manualReview}</span>` : "0"}</td>
    </tr>`,
    )
    .join("");

  return `
  <div class="section">
    <div class="section-heading">By Project</div>
    <table>
      <thead>
        <tr>
          <th>Project</th>
          <th style="text-align:center">Total</th>
          <th style="text-align:center">Unique</th>
          <th style="text-align:center">Duplicates</th>
          <th style="text-align:center">Manual Review</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildFilesSection(files: readonly LogEntry[]): string {
  if (files.length === 0) {
    return `<div class="section">
      <div class="section-heading">Files Added (0)</div>
      <p class="empty">No new files in this period.</p>
    </div>`;
  }

  const rows = files
    .map(
      (f) => `
    <tr>
      <td style="white-space:nowrap">${fmtDateShort(f.processedAtIso)}</td>
      <td>${esc(f.senderId)}</td>
      <td style="white-space:nowrap"><strong>${esc(f.projectName)}</strong></td>
      <td>${resolutionBadge(f.projectResolutionSource)}</td>
      <td>${renderPreviewCell(f)}</td>
      <td>${renderFilename(f)}</td>
      <td>${categoryBadge(f.category)}</td>
      <td>${esc(f.rootFolder)}${f.phase ? ` / ${esc(f.phase)}` : ""}</td>
      <td>${confidence(f.confidence)}</td>
      <td>${sourceBadge(f.classificationSource)}</td>
      <td class="path">${esc(f.relativePath)}</td>
    </tr>`,
    )
    .join("");

  return `
  <div class="section">
    <div class="section-heading">Files Added (${files.length})</div>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Sender</th>
          <th>Project</th>
          <th>Resolved By</th>
          <th>Preview</th>
          <th>Final Filename</th>
          <th>Category</th>
          <th>Folder / Phase</th>
          <th>Confidence</th>
          <th>AI Source</th>
          <th>Saved Path</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildDuplicatesSection(duplicates: readonly LogEntry[]): string {
  if (duplicates.length === 0) {
    return `<div class="section">
      <div class="section-heading">Duplicates (0)</div>
      <p class="empty">No duplicates detected in this period.</p>
    </div>`;
  }

  const rows = duplicates
    .map(
      (f) => `
    <tr>
      <td style="white-space:nowrap">${fmtDateShort(f.processedAtIso)}</td>
      <td>${esc(f.senderId)}</td>
      <td><strong>${esc(f.projectName)}</strong></td>
      <td>${esc(f.fileName)}</td>
      <td><span class="badge badge-${f.duplicateType ?? "exact"}">${f.duplicateType ?? "—"}</span></td>
      <td class="path">${esc(f.duplicateMatchedPath)}</td>
      <td class="path">${esc(f.relativePath)}</td>
    </tr>`,
    )
    .join("");

  return `
  <div class="section">
    <div class="section-heading">Duplicates (${duplicates.length})</div>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Sender</th>
          <th>Project</th>
          <th>Filename</th>
          <th>Type</th>
          <th>Matched File</th>
          <th>Stored At</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildManualReviewSection(manualReview: readonly LogEntry[]): string {
  if (manualReview.length === 0) {
    return `<div class="section">
      <div class="section-heading">Manual Review (0)</div>
      <p class="empty">No items routed to Manual Review in this period.</p>
    </div>`;
  }

  const rows = manualReview
    .map(
      (f) => `
    <tr>
      <td style="white-space:nowrap">${fmtDateShort(f.processedAtIso)}</td>
      <td>${esc(f.senderId)}</td>
      <td>${esc(f.fileName)}</td>
      <td>${categoryBadge(f.category)}</td>
      <td>${confidence(f.confidence)}</td>
      <td class="path">${esc(f.relativePath)}</td>
    </tr>`,
    )
    .join("");

  return `
  <div class="section">
    <div class="section-heading" style="color:#dc2626">Manual Review (${manualReview.length})</div>
    <p style="font-size:12px;color:#64748b;margin-bottom:12px">
      These files could not be confidently assigned to a project and require manual review.
    </p>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Sender</th>
          <th>Saved Filename</th>
          <th>Category</th>
          <th>Confidence</th>
          <th>Stored At</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------------------------
// Full report HTML
// ---------------------------------------------------------------------------

export function buildReportHtml(data: ReportData): string {
  const generatedStr = fmtDate(data.generatedAtIso);
  const periodStr = fmtDate(data.periodStartIso);
  const modeLabel = TEST_MODE ? "[TEST]" : "Weekly";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Archive Report</title>
  <style>${CSS}</style>
</head>
<body>
<div class="wrapper">

  <div class="header">
    <div class="header-brand">iMessage Archiver</div>
    <div class="header-title">${modeLabel} Archive Report</div>
    <div class="header-period">
      Period: ${periodStr} &#8211; ${generatedStr}
    </div>
  </div>

  <div class="content">
    ${buildSummarySection(data)}
    ${buildProjectSection(data.byProject)}
    ${buildFilesSection(data.files)}
    ${buildDuplicatesSection(data.duplicates)}
    ${buildManualReviewSection(data.manualReview)}
  </div>

  <div class="footer">
    iMessage Archiver &bull; Auto-generated on ${generatedStr}
  </div>

</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateReport(
  logFilePath: string,
  periodStart: Date,
): Promise<ReportData> {
  const entries = await readLogEntries(logFilePath);
  const data = buildReportData(entries, periodStart, new Date().toISOString());

  await fs.ensureDir(appPaths.weeklyReportDir);
  const reportPath = path.join(
    appPaths.weeklyReportDir,
    `report-${data.generatedAtIso.slice(0, 16).replace("T", "_").replace(":", "-")}.html`,
  );
  await fs.writeFile(reportPath, buildReportHtml(data), "utf8");

  logger.info(
    {
      reportPath,
      total: data.summary.total,
      unique: data.summary.unique,
      duplicates: data.summary.duplicates,
      manualReview: data.summary.manualReview,
      periodStart: data.periodStartIso,
    },
    "Report generated",
  );

  return data;
}

export async function sendReportEmail(data: ReportData): Promise<void> {
  const from = env.REPORT_EMAIL_FROM;
  if (!from) {
    logger.warn("REPORT_EMAIL_FROM not configured — skipping report email");
    return;
  }

  const to = env.REPORT_EMAIL_TO;

  if (!to) {
    logger.warn("REPORT_EMAIL_TO not configured — skipping report email");
    return;
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const modeLabel = TEST_MODE ? "[TEST]" : "Weekly";
  const counts = [
    `${data.summary.unique} file${data.summary.unique !== 1 ? "s" : ""}`,
    ...(data.summary.duplicates > 0
      ? [
          `${data.summary.duplicates} duplicate${data.summary.duplicates !== 1 ? "s" : ""}`,
        ]
      : []),
    ...(data.summary.manualReview > 0
      ? [`${data.summary.manualReview} manual review`]
      : []),
  ].join(", ");
  const subject = `${modeLabel} Archive Report — ${counts} — ${fmtDate(data.generatedAtIso)}`;

  let success = true;
  let errorMessage: string | undefined;

  try {
    await resend.emails.send({
      from,
      to: [to],
      subject,
      html: buildReportHtml(data),
    });
    logger.info({ to, subject }, "Report email sent");
  } catch (err: unknown) {
    success = false;
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: err, to, subject }, "Report email failed");
    throw err;
  } finally {
    await reportLog.write({
      ts: new Date().toISOString(),
      periodStartIso: data.periodStartIso,
      totalFiles: data.summary.total,
      uniqueFiles: data.summary.unique,
      duplicates: data.summary.duplicates,
      manualReview: data.summary.manualReview,
      affectedProjects: data.summary.affectedProjects,
      recipientEmail: to,
      success,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Legacy aliases
// ---------------------------------------------------------------------------

export const generateWeeklyReport = (
  logFilePath: string,
): Promise<ReportData> => generateReport(logFilePath, getReportPeriodStart());

export const sendWeeklyReportEmail = sendReportEmail;

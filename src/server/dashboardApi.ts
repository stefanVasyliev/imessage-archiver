import * as http from "node:http";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { env } from "../config/env.js";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";
import {
  generateReport,
  sendReportEmail,
  getReportPeriodStart,
} from "../services/weeklyReport.js";
import { getDashboardHtml } from "./dashboardHtml.js";

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

async function readJsonl<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const results: T[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = schema.safeParse(JSON.parse(trimmed));
      if (parsed.success) results.push(parsed.data);
    }
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Log schemas (loose — dashboard only needs what it renders)
// ---------------------------------------------------------------------------

const processedEntrySchema = z.object({
  processedAtIso: z.string(),
  messageRowId: z.number(),
  senderId: z.string().default("unknown"),
  projectName: z.string(),
  originalFilename: z.string().optional(),
  fileName: z.string(),
  relativePath: z.string(),
  rootFolder: z.string(),
  phase: z.string().optional(),
  category: z.string(),
  confidence: z.number(),
  isDuplicate: z.boolean(),
  duplicateType: z.string().optional(),
  duplicateMatchedPath: z.string().optional(),
  classificationSource: z.string(),
});

const activityEntrySchema = z.object({
  ts: z.string(),
  kind: z.string(),
  messageRowId: z.number().optional(),
  senderId: z.string().optional(),
  projectName: z.string().optional(),
  fileName: z.string().optional(),
  detail: z.string().optional(),
});

const messageEntrySchema = z.object({
  ts: z.string(),
  messageRowId: z.number(),
  senderId: z.string(),
  isFromMe: z.boolean(),
  text: z.string().nullable(),
  projectName: z.string().optional(),
  projectSource: z.string().optional(),
});

const reportEntrySchema = z.object({
  ts: z.string(),
  periodStartIso: z.string(),
  totalFiles: z.number(),
  uniqueFiles: z.number(),
  duplicates: z.number(),
  manualReview: z.number(),
  affectedProjects: z.number(),
  recipientEmail: z.string(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
});

const MANUAL_REVIEW_SLUG = "ManualReview";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleOverview(res: http.ServerResponse): Promise<void> {
  const [processed, activity, messages, reports] = await Promise.all([
    readJsonl(appPaths.processedLogFile, processedEntrySchema),
    readJsonl(appPaths.activityLogFile, activityEntrySchema),
    readJsonl(appPaths.messageLogFile, messageEntrySchema),
    readJsonl(appPaths.reportLogFile, reportEntrySchema),
  ]);

  const unique = processed.filter((e) => !e.isDuplicate);
  const duplicates = processed.filter((e) => e.isDuplicate);
  const manualReview = processed.filter(
    (e) => e.projectName === MANUAL_REVIEW_SLUG,
  );

  const affectedProjects = new Set(
    processed
      .filter((e) => e.projectName !== MANUAL_REVIEW_SLUG)
      .map((e) => e.projectName),
  ).size;

  // Recent activity — last 50 events
  const recentActivity = activity.slice(-50).reverse();

  // Project summary
  const projectMap = new Map<
    string,
    { total: number; duplicates: number; manualReview: number }
  >();
  for (const e of processed) {
    if (e.projectName === MANUAL_REVIEW_SLUG) continue;
    const cur = projectMap.get(e.projectName) ?? {
      total: 0,
      duplicates: 0,
      manualReview: 0,
    };
    projectMap.set(e.projectName, {
      total: cur.total + 1,
      duplicates: cur.duplicates + (e.isDuplicate ? 1 : 0),
      manualReview: 0,
    });
  }
  const byProject = Array.from(projectMap.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([projectName, stats]) => ({ projectName, ...stats }));

  json(res, {
    totalFiles: processed.length,
    uniqueFiles: unique.length,
    totalDuplicates: duplicates.length,
    totalManualReview: manualReview.length,
    affectedProjects,
    totalMessages: messages.length,
    totalReports: reports.filter((r) => r.success).length,
    recentActivityCount: recentActivity.length,
    byProject,
  });
}

async function handleActivity(res: http.ServerResponse): Promise<void> {
  const activity = await readJsonl(appPaths.activityLogFile, activityEntrySchema);
  // Return last 100, newest first
  json(res, activity.slice(-100).reverse());
}

async function handleFiles(res: http.ServerResponse): Promise<void> {
  const processed = await readJsonl(
    appPaths.processedLogFile,
    processedEntrySchema,
  );
  // Unique (non-duplicate) files, newest first
  json(res, processed.filter((e) => !e.isDuplicate).reverse());
}

async function handleMessages(res: http.ServerResponse): Promise<void> {
  const messages = await readJsonl(
    appPaths.messageLogFile,
    messageEntrySchema,
  );
  json(res, messages.slice(-200).reverse());
}

async function handleDuplicates(res: http.ServerResponse): Promise<void> {
  const processed = await readJsonl(
    appPaths.processedLogFile,
    processedEntrySchema,
  );
  json(res, processed.filter((e) => e.isDuplicate).reverse());
}

async function handleManualReview(res: http.ServerResponse): Promise<void> {
  const processed = await readJsonl(
    appPaths.processedLogFile,
    processedEntrySchema,
  );
  json(
    res,
    processed.filter((e) => e.projectName === MANUAL_REVIEW_SLUG).reverse(),
  );
}

async function handleReports(res: http.ServerResponse): Promise<void> {
  const reports = await readJsonl(appPaths.reportLogFile, reportEntrySchema);
  json(res, reports.reverse());
}

async function handleRunReport(res: http.ServerResponse): Promise<void> {
  try {
    const data = await generateReport(
      appPaths.processedLogFile,
      getReportPeriodStart(),
    );
    await sendReportEmail(data);
    json(res, { ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: err }, "Dashboard-triggered report failed");
    json(res, { ok: false, error: message }, 500);
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST" });
    res.end();
    return;
  }

  if (url === "/" || url === "/index.html") {
    html(res, getDashboardHtml(env.DASHBOARD_PORT));
    return;
  }

  if (!url.startsWith("/api/dashboard")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const route = url.replace(/\?.*$/, ""); // strip query string

  if (method === "GET" && route === "/api/dashboard/overview") {
    await handleOverview(res);
  } else if (method === "GET" && route === "/api/dashboard/activity") {
    await handleActivity(res);
  } else if (method === "GET" && route === "/api/dashboard/files") {
    await handleFiles(res);
  } else if (method === "GET" && route === "/api/dashboard/messages") {
    await handleMessages(res);
  } else if (method === "GET" && route === "/api/dashboard/duplicates") {
    await handleDuplicates(res);
  } else if (method === "GET" && route === "/api/dashboard/manual-review") {
    await handleManualReview(res);
  } else if (method === "GET" && route === "/api/dashboard/reports") {
    await handleReports(res);
  } else if (method === "POST" && route === "/api/dashboard/reports/run") {
    await handleRunReport(res);
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function startDashboard(): void {
  const port = env.DASHBOARD_PORT;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ error: err, url: req.url }, "Dashboard request error");
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    });
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info({ port }, "Dashboard listening on http://localhost:" + String(port));
  });

  server.on("error", (err: Error) => {
    logger.error({ error: err }, "Dashboard server error");
  });
}

import { schedule } from "node-cron";
import fs from "fs-extra";
import * as path from "node:path";
import { env } from "./config/env.js";
import type Database from "better-sqlite3";
import { openChatDb, getCurrentMaxMessageRowId } from "./db/chatDb.js";
import { readState, writeState, initializeStartupState } from "./db/stateStore.js";
import {
  classifyAttachment,
  type ClassificationResult,
} from "./services/aiClassifier.js";
import {
  optimizeImageForAI,
  extractVideoFrameForAI,
  cleanupAiPreview,
} from "./services/aiMediaPreview.js";
import { moveToDirectory } from "./services/archiveFile.js";
import { createActivityLog } from "./db/activityLog.js";
import { createMessageLog } from "./db/messageLog.js";
import { startDashboard } from "./server/dashboardApi.js";
import { createDuplicateAlert } from "./services/duplicateAlert.js";
import { detectDuplicate } from "./services/duplicateDetector.js";
import { extractAttachment } from "./services/extractAttachments.js";
import { createMetadataLog } from "./services/metadataLog.js";
import {
  getNewAttachmentRows,
  getNewTextMessages,
  getRecentTextMessages,
  getLastMeaningfulTextMessageBySenderBefore,
  type RawAttachmentRow,
  type TextMessageRow,
} from "./services/pollMessages.js";
import {
  getKnownProjects,
  resolveProject,
  findMatchingProject,
  parseProjectTag,
  MANUAL_REVIEW_PROJECT,
} from "./services/projectResolver.js";
import { UserContextStore } from "./services/userContextStore.js";
import {
  generateReport,
  sendReportEmail,
  CRON_SCHEDULE,
  getReportPeriodStart,
} from "./services/weeklyReport.js";
import { buildFinalNaming } from "./utils/finalNaming.js";
import { appleMessageDateToDate } from "./utils/date.js";
import { getFileCategory } from "./utils/fileType.js";
import { appPaths } from "./utils/filePaths.js";
import { logger } from "./utils/logger.js";

const metadataLog = createMetadataLog(appPaths.processedLogFile);
const activityLog = createActivityLog(appPaths.activityLogFile);
const messageLog = createMessageLog(appPaths.messageLogFile);
const duplicateAlert = createDuplicateAlert(env.RESEND_API_KEY);
const contextStore = new UserContextStore();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function ensureDirectories(): Promise<void> {
  await Promise.all([
    fs.ensureDir(appPaths.root),
    fs.ensureDir(appPaths.weeklyReportDir),
    fs.ensureDir(appPaths.logsDir),
    fs.ensureDir(appPaths.duplicatesDir),
    fs.ensureDir(appPaths.tempIncoming),
    fs.ensureDir(appPaths.manualReviewDir),
  ]);
}

// ---------------------------------------------------------------------------
// Sender ID helper
// ---------------------------------------------------------------------------

function getSenderId(row: {
  isFromMe: number;
  handleId: string | null;
}): string {
  return row.handleId ?? "unknown";
}

startDashboard();

// ---------------------------------------------------------------------------
// Render detection — based on file extension or keyword in name / message
// ---------------------------------------------------------------------------

const RENDER_EXTENSIONS = new Set([
  ".skp",
  ".dwg",
  ".dxf",
  ".fbx",
  ".obj",
  ".blend",
  ".rvt",
  ".3dm",
]);
const RENDER_KEYWORDS = ["render", "3d", "elevation", "concept", "viz"];

function isLikelyRender(
  filePath: string,
  messageText: string | null,
  originalFilename: string | null,
): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (RENDER_EXTENSIONS.has(ext)) return true;
  const combined = [filePath, messageText ?? "", originalFilename ?? ""]
    .join(" ")
    .toLowerCase();
  return RENDER_KEYWORDS.some((kw) => combined.includes(kw));
}

function buildRenderClassification(): ClassificationResult {
  return {
    phase: "Finish", // not used — Renders folder has no phase
    folderHint: "Renders",
    description: "Render",
    confidence: 0.9,
    classificationSource: "default-fallback",
    action: "auto_route",
  };
}

// ---------------------------------------------------------------------------
// Target directory resolution — strict folder existence checks.
//
// Rules:
//   • Unknown project (MANUAL_REVIEW_PROJECT) → global ManualReview/
//   • Project folder missing on disk → global ManualReview/
//   • rootFolder (Photos/Videos/Renders/Final) missing → [Project]/Manual Review/
//   • phase missing (Photos/Videos) → [Project]/Manual Review/
//   • phase folder missing on disk → [Project]/Manual Review/
// ---------------------------------------------------------------------------

const VIDEO_CONFIDENCE_THRESHOLD = 0.4;

type RoutingResult = {
  dir: string;
  routingMode: "project" | "project-manual-review" | "global-manual-review";
};

async function resolveTargetDirectory(params: {
  projectName: string;
  rootFolder: string;
  phaseFolder: string | undefined;
}): Promise<RoutingResult> {
  const { projectName, rootFolder, phaseFolder } = params;

  // Unknown project → global ManualReview.
  if (projectName === MANUAL_REVIEW_PROJECT) {
    return {
      dir: appPaths.manualReviewDir,
      routingMode: "global-manual-review",
    };
  }

  // Use projectName as-is — it comes from getKnownProjects() which reads actual
  // folder names from disk.  normalizeProjectName() would corrupt names like
  // "Office_OrangeCounty_ModernRed" → "OfficeOrangeCountyModernRed", causing a
  // false path-not-found and a silent fallback to ManualReview.
  const projectRoot = path.join(appPaths.root, projectName);

  // Project folder must exist — never auto-create.
  if (!(await fs.pathExists(projectRoot))) {
    logger.warn(
      { projectName, projectRoot },
      "[routing] Project folder not found — routing to global ManualReview",
    );
    return {
      dir: appPaths.manualReviewDir,
      routingMode: "global-manual-review",
    };
  }

  logger.info(
    { operation: "resolveTargetDirectory", projectName, projectRoot },
    "[routing] Project root exists on disk",
  );

  const projectManualReview = path.join(projectRoot, "Manual Review");

  // Renders / Final: no phase subfolder needed.
  if (rootFolder === "Renders" || rootFolder === "Final") {
    const targetDir = path.join(projectRoot, rootFolder);
    if (!(await fs.pathExists(targetDir))) {
      logger.warn(
        { targetDir },
        "[routing] Root folder not found on disk — routing to project Manual Review",
      );
      await fs.ensureDir(projectManualReview);
      return { dir: projectManualReview, routingMode: "project-manual-review" };
    }
    logger.info(
      { operation: "resolveTargetDirectory", projectName, rootFolder, targetDir, routingMode: "project" },
      "[routing] Routing to Renders/Final folder",
    );
    return { dir: targetDir, routingMode: "project" };
  }

  // Photos / Videos: rootFolder must exist.
  const rootDir = path.join(projectRoot, rootFolder);
  if (!(await fs.pathExists(rootDir))) {
    logger.warn(
      { rootDir },
      "[routing] Root folder not found on disk — routing to project Manual Review",
    );
    await fs.ensureDir(projectManualReview);
    return { dir: projectManualReview, routingMode: "project-manual-review" };
  }

  logger.info(
    { operation: "resolveTargetDirectory", projectName, rootFolder, rootDir },
    "[routing] Root folder (Photos/Videos) exists on disk",
  );

  // Phase unknown — fall back to root folder (Photos/ or Videos/).
  if (phaseFolder === undefined) {
    logger.info(
      { projectName, rootFolder, rootDir, routingMode: "project" },
      "[routing] Phase unknown — falling back to root folder",
    );
    return { dir: rootDir, routingMode: "project" };
  }

  // Phase folder must exist — if not, fall back to root folder.
  const phaseDir = path.join(rootDir, phaseFolder);
  if (!(await fs.pathExists(phaseDir))) {
    logger.warn(
      { phaseDir, rootDir, routingMode: "project" },
      "[routing] Phase folder not found on disk — falling back to root folder",
    );
    return { dir: rootDir, routingMode: "project" };
  }
  logger.info(
    { operation: "resolveTargetDirectory", projectName, rootFolder, phaseFolder, phaseDir, routingMode: "project" },
    "[routing] Routing to phase folder",
  );
  return { dir: phaseDir, routingMode: "project" };
}

// ---------------------------------------------------------------------------
// Main polling loop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context seeding helper
// ---------------------------------------------------------------------------

/**
 * Resolve a project name from a single text message.
 * Tries explicit Project: tag first, then fuzzy substring match.
 * Returns null if no known project is identified.
 */
function matchProjectFromText(
  text: string,
  knownProjects: string[],
): string | null {
  // 1. Explicit tag (e.g. "Project: Studio_WoodlandHills_GoldStyle")
  const tag = parseProjectTag(text);
  if (tag !== null) {
    if (knownProjects.includes(tag)) return tag;
    const loose = findMatchingProject(tag, knownProjects);
    if (loose !== null) return loose;
  }
  // 2. Fuzzy substring match against full message text
  return findMatchingProject(text, knownProjects);
}

/**
 * Apply project context from a text row: update both sender and chat context
 * and emit structured logs.
 *
 * Uses the Apple message date as sentAtMs so the 20-minute validity window
 * is based on when the sender actually typed the message, not processing time.
 */
function applyContextFromTextRow(
  row: TextMessageRow,
  projectName: string,
  source: "recent-history-scan" | "new-message",
): void {
  const senderId = getSenderId(row);
  const sentAtMs =
    appleMessageDateToDate(row.messageDate)?.getTime() ?? Date.now();

  contextStore.setSender(senderId, row.text ?? "", { projectName, sentAtMs });
  logger.info(
    {
      source,
      senderId,
      chatId: row.chatId,
      projectName,
      messageRowId: row.messageRowId,
      ageMinutes: Math.round((Date.now() - sentAtMs) / 60_000),
      text: row.text?.slice(0, 120),
    },
    "Sender context updated from text message",
  );

  contextStore.setChat(row.chatId, projectName, row.text ?? "");
  logger.info(
    {
      source,
      chatId: row.chatId,
      projectName,
      messageRowId: row.messageRowId,
    },
    "Chat context updated from text message",
  );
}

// ---------------------------------------------------------------------------
// Main polling loop
// ---------------------------------------------------------------------------

async function processNewMessages(): Promise<void> {
  const db = openChatDb();

  try {
    const state = await readState();
    const knownProjects = await getKnownProjects();
    logger.info(
      {
        operation: "getKnownProjects",
        count: knownProjects.length,
        projects: knownProjects,
        storageRoot: appPaths.root,
      },
      "Known projects loaded",
    );

    // ---- Context seeding pass (history-scan) ----
    // Read the 30 most recent text messages regardless of the state pointer so
    // that project-defining messages sent before the last processed attachment
    // ROWID are still captured (e.g. after restart or pointer advancement).
    // recentRows is newest-first; we walk it to find the most recent useful message.
    let recentRows: TextMessageRow[];
    try {
      recentRows = getRecentTextMessages(db, 30);
    } catch (err: unknown) {
      logger.error(
        { error: err, operation: "getRecentTextMessages" },
        "Failed to query recent text messages for context seeding — continuing with empty context",
      );
      recentRows = [];
    }

    logger.info(
      {
        operation: "getRecentTextMessages",
        count: recentRows.length,
        rowIdRange:
          recentRows.length > 0
            ? {
                newest: recentRows.at(0)?.messageRowId ?? null,
                oldest: recentRows.at(-1)?.messageRowId ?? null,
              }
            : null,
        senderIds: [...new Set(recentRows.map((r) => r.handleId ?? "me"))],
        texts: recentRows.slice(0, 5).map((r) => r.text?.slice(0, 60) ?? null),
      },
      recentRows.length === 0
        ? "No recent text rows found for context seeding"
        : "Recent text rows fetched for context seeding",
    );

    {
      // Collect up to 5 recent non-matching messages as raw hints.
      // recentRows is newest-first; we reverse before storing so the context
      // store accumulates them oldest-first (the correct order for AI context).
      const hintRows: TextMessageRow[] = [];
      let resolvedFromHistory = false;
      // Track which senders we have already seeded so we store only the most
      // recent message per sender (first occurrence in newest-first iteration).
      const seededSenders = new Set<string>();

      for (const row of recentRows) {
        if (!row.text) continue;
        const senderId = getSenderId(row);
        const sentAtMs =
          appleMessageDateToDate(row.messageDate)?.getTime() ?? Date.now();

        // Seed the most recent text for this sender (skip older messages for the
        // same sender — they will be overwritten if applyContextFromTextRow fires).
        if (!seededSenders.has(senderId)) {
          contextStore.setSender(senderId, row.text, { sentAtMs });
          seededSenders.add(senderId);
        }

        const projectName = matchProjectFromText(row.text, knownProjects);
        if (projectName !== null) {
          // applyContextFromTextRow upgrades the sender entry with a resolved
          // projectName and correct sentAtMs — overwriting the seed above.
          applyContextFromTextRow(row, projectName, "recent-history-scan");
          resolvedFromHistory = true;
          break;
        }
        if (hintRows.length < 5) {
          hintRows.push(row);
        }
      }

      // Only store raw hints when no resolved project was found.
      // Store oldest-first so setChatHint accumulates them in chronological order.
      if (!resolvedFromHistory) {
        for (const row of [...hintRows].reverse()) {
          if (!row.text) continue;
          contextStore.setChatHint(row.chatId, row.text);
        }
      }
    }

    // ---- New text-message pass ----
    // Handles messages strictly newer than lastProcessedMessageRowId.
    // Always stores raw hint; upgrades to resolved context when a project matches.
    let textRows: TextMessageRow[];
    try {
      textRows = getNewTextMessages(db, state.lastProcessedMessageRowId);
    } catch (err: unknown) {
      logger.error(
        {
          error: err,
          operation: "getNewTextMessages",
          lastProcessedMessageRowId: state.lastProcessedMessageRowId,
        },
        "Failed to query new text messages — skipping text-message pass",
      );
      textRows = [];
    }

    logger.info(
      {
        operation: "getNewTextMessages",
        lastProcessedMessageRowId: state.lastProcessedMessageRowId,
        chatId: env.TARGET_CHAT_ID,
        count: textRows.length,
        rowIdRange:
          textRows.length > 0
            ? {
                min: textRows.at(0)?.messageRowId ?? null,
                max: textRows.at(-1)?.messageRowId ?? null,
              }
            : null,
        senderIds: [...new Set(textRows.map((r) => r.handleId ?? "me"))],
        texts: textRows.map((r) => ({ rowId: r.messageRowId, text: r.text?.slice(0, 80) ?? null })),
      },
      textRows.length === 0 ? "No new text messages found" : "New text messages fetched",
    );

    for (const textRow of textRows) {
      if (!textRow.text) continue;
      const senderId = getSenderId(textRow);

      void messageLog.write({
        ts: new Date().toISOString(),
        messageRowId: textRow.messageRowId,
        senderId,
        isFromMe: textRow.isFromMe === 1,
        text: textRow.text,
      });

      // Always store the sender's last text message so that ANY text they send
      // becomes their active context — not only project-matching messages.
      // New messages arrive in real-time so sentAtMs ≈ Date.now().
      contextStore.setSender(senderId, textRow.text);

      const projectName = matchProjectFromText(textRow.text, knownProjects);
      logger.info(
        {
          messageRowId: textRow.messageRowId,
          senderId,
          chatId: textRow.chatId,
          text: textRow.text.slice(0, 120),
          projectMatched: projectName,
        },
        "New text message evaluated for project context",
      );

      if (projectName !== null) {
        // Upgrade sender entry with resolved projectName, then update chat context.
        applyContextFromTextRow(textRow, projectName, "new-message");
        void activityLog.write({
          ts: new Date().toISOString(),
          kind: "context_updated",
          messageRowId: textRow.messageRowId,
          senderId,
          projectName,
          detail: textRow.text.slice(0, 120),
        });
      } else {
        // No pre-resolved project — store raw text as a weak chat hint so the AI
        // can use informal references like "woodland" or "orange office".
        contextStore.setChatHint(textRow.chatId, textRow.text);
        logger.info(
          {
            chatId: textRow.chatId,
            senderId,
            hint: textRow.text.slice(0, 120),
            messageRowId: textRow.messageRowId,
          },
          "Raw chat hint stored from new text message",
        );
      }
    }

    let rows: RawAttachmentRow[];
    try {
      rows = getNewAttachmentRows(db, state.lastProcessedMessageRowId);
    } catch (err: unknown) {
      logger.error(
        {
          error: err,
          operation: "getNewAttachmentRows",
          lastProcessedMessageRowId: state.lastProcessedMessageRowId,
          chatId: env.TARGET_CHAT_ID,
        },
        "Failed to query new attachment rows — aborting poll cycle",
      );
      return;
    }

    logger.info(
      {
        operation: "getNewAttachmentRows",
        lastProcessedMessageRowId: state.lastProcessedMessageRowId,
        chatId: env.TARGET_CHAT_ID,
        count: rows.length,
        rowIdRange:
          rows.length > 0
            ? {
                min: rows.at(0)?.messageRowId ?? null,
                max: rows.at(-1)?.messageRowId ?? null,
              }
            : null,
        attachments: rows.map((r) => ({
          messageRowId: r.messageRowId,
          attachmentRowId: r.attachmentRowId,
          handleId: r.handleId,
          isFromMe: r.isFromMe,
          filename: r.attachmentFilename,
          mimeType: r.attachmentMimeType,
          chatDisplayName: r.chatDisplayName,
        })),
      },
      rows.length === 0 ? "No new attachment rows found" : "New attachment rows fetched",
    );

    let newestRowId = state.lastProcessedMessageRowId;

    for (const row of rows) {
      newestRowId = Math.max(newestRowId, row.messageRowId);

      try {
        await processAttachment(row, knownProjects, db);
      } catch (error: unknown) {
        logger.error(
          {
            error,
            operation: "processAttachment",
            messageRowId: row.messageRowId,
            attachmentRowId: row.attachmentRowId,
            chatId: row.chatId,
            senderId: getSenderId(row),
            attachmentFilename: row.attachmentFilename,
          },
          "Unexpected error processing attachment — skipping",
        );
      }
    }

    await writeState({ lastProcessedMessageRowId: newestRowId });
  } finally {
    db.close();
  }
}

async function processAttachment(
  row: RawAttachmentRow,
  knownProjects: string[],
  db: Database.Database,
): Promise<void> {
  const senderId = getSenderId(row);

  logger.info(
    {
      operation: "processAttachment:start",
      messageRowId: row.messageRowId,
      attachmentRowId: row.attachmentRowId,
      chatId: row.chatId,
      senderId,
      handleId: row.handleId,
      isFromMe: row.isFromMe,
      originalFilename: row.attachmentFilename,
      mimeType: row.attachmentMimeType,
      messageText: row.text?.slice(0, 120) ?? null,
      messageGuid: row.messageGuid,
      chatDisplayName: row.chatDisplayName,
    },
    "Starting attachment processing",
  );

  // ---- File extraction ----

  const extracted = await extractAttachment(row);
  if (!extracted) {
    logger.error(
      {
        operation: "extractAttachment",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        chatId: row.chatId,
        senderId,
        attachmentFilename: row.attachmentFilename,
      },
      "Attachment extraction returned null — file missing or unreadable, skipping",
    );
    return;
  }

  const category = getFileCategory(extracted.destinationPath);

  if (category === "unknown") {
    logger.warn(
      { messageRowId: row.messageRowId, sourcePath: extracted.destinationPath },
      "Unsupported file type — skipping",
    );
    return;
  }

  // Use valid sender context (within 20-min window) to enrich AI classification.
  // If the sender's last text is stale, skip it rather than routing to wrong project.
  const validSenderContext = contextStore.getValidSender(senderId);
  if (
    validSenderContext === null &&
    contextStore.getSender(senderId) !== null
  ) {
    logger.info(
      { senderId, messageRowId: row.messageRowId },
      "Sender context expired — will use AI fallback for project resolution",
    );
  }
  const combinedMessageText =
    [row.text, validSenderContext?.rawMessageText].filter(Boolean).join(" ") ||
    null;

  const renderDetected = isLikelyRender(
    extracted.destinationPath,
    combinedMessageText,
    row.attachmentFilename,
  );

  // ---- Generate shared preview (image or video frame) ----
  // Renders skip this — they go straight to [Project]/Renders without AI.
  // The preview is passed to both the project resolver and the classifier so
  // we only generate it once.

  const previewTempDir = path.join(process.cwd(), ".tmp", "ai-previews");
  let sharedPreviewPath: string | null = null;

  if (!renderDetected) {
    if (category === "image") {
      try {
        const preview = await optimizeImageForAI({
          inputPath: extracted.destinationPath,
          tempDir: previewTempDir,
          maxWidth: 1200,
          maxHeight: 1200,
          jpegQuality: 76,
        });
        sharedPreviewPath = preview.previewPath;
      } catch (err: unknown) {
        logger.warn(
          { error: err, filePath: extracted.destinationPath },
          "Image preview generation failed — proceeding without preview",
        );
      }
    } else if (category === "video") {
      try {
        const frame = await extractVideoFrameForAI({
          inputPath: extracted.destinationPath,
          tempDir: previewTempDir,
          width: 1280,
          seekSeconds: 2,
        });
        sharedPreviewPath = frame.framePath;
        logger.info(
          {
            filePath: extracted.destinationPath,
            framePath: sharedPreviewPath,
            originalBytes: frame.originalBytes,
            frameBytes: frame.frameBytes,
          },
          "Generated shared video frame preview",
        );
      } catch (err: unknown) {
        logger.warn(
          { error: err, filePath: extracted.destinationPath },
          "Video frame extraction failed — proceeding without preview",
        );
      }
    }
  }

  // ---- DB context enrichment ----
  // Fetch sender's last meaningful text AND recent chat messages directly from
  // DB at processing time — guarantees context even when the in-memory store is
  // empty (restart, same-batch race, or first run).

  let lastSenderMessage: string | null = null;
  try {
    lastSenderMessage = getLastMeaningfulTextMessageBySenderBefore(db, {
      isFromMe: row.isFromMe,
      handleId: row.handleId,
      chatId: row.chatId,
      beforeRowId: row.messageRowId,
    });
  } catch (err: unknown) {
    logger.error(
      {
        error: err,
        operation: "getLastMeaningfulTextMessageBySenderBefore",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        chatId: row.chatId,
        senderId,
        handleId: row.handleId,
        beforeRowId: row.messageRowId,
      },
      "DB query for sender's last message failed — proceeding without sender context",
    );
  }

  if (lastSenderMessage === null && env.OPENAI_API_KEY) {
    logger.warn(
      {
        operation: "processAttachment:no-context",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        chatId: row.chatId,
        senderId,
        hasValidSenderContext: contextStore.getValidSender(senderId) !== null,
        hasStaleSenderContext: contextStore.getSender(senderId) !== null,
        hasChatContext: contextStore.getChat(row.chatId) !== null,
      },
      "No DB context found for this attachment — AI will proceed without text context",
    );
  }

  const _chatCtxForLog = contextStore.getChat(row.chatId);
  logger.info(
    {
      operation: "processAttachment:context-summary",
      messageRowId: row.messageRowId,
      attachmentRowId: row.attachmentRowId,
      senderId,
      lastSenderMessageFound: lastSenderMessage !== null,
      lastSenderMessage: lastSenderMessage?.slice(0, 120) ?? null,
      validSenderContext:
        validSenderContext !== null
          ? {
              projectName: validSenderContext.projectName ?? null,
              ageMinutes: Math.round(
                (Date.now() - validSenderContext.setAtMs) / 60_000,
              ),
              textPreview: validSenderContext.rawMessageText.slice(0, 80),
            }
          : null,
      chatContext:
        _chatCtxForLog !== null
          ? {
              projectName: _chatCtxForLog.projectName ?? null,
              textPreview: _chatCtxForLog.rawMessageText?.slice(0, 80) ?? null,
              rawMessagesCount: _chatCtxForLog.rawMessages.length,
            }
          : null,
      combinedMessageText: combinedMessageText?.slice(0, 120) ?? null,
      category,
      sharedPreviewPath,
    },
    "Context summary before project resolution",
  );

  // Fast-path: try to resolve project from the single last sender message.
  if (lastSenderMessage !== null) {
    const dbProject = matchProjectFromText(lastSenderMessage, knownProjects);
    if (dbProject !== null) {
      contextStore.setSender(senderId, lastSenderMessage, {
        projectName: dbProject,
        sentAtMs: Date.now(),
      });
      contextStore.setChat(row.chatId, dbProject, lastSenderMessage);
      logger.info(
        { messageRowId: row.messageRowId, senderId, dbProject, matchedText: lastSenderMessage.slice(0, 80) },
        "[context] Project matched from last sender message — context store seeded",
      );
    }
  }

  try {
    // ---- Project resolution (uses preview for AI inference) ----

    logger.info(
      {
        operation: "resolveProject:inputs",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        senderId,
        chatId: row.chatId,
        messageText: row.text?.slice(0, 120) ?? null,
        originalFilename: row.attachmentFilename,
        lastSenderMessage: lastSenderMessage?.slice(0, 120) ?? null,
        hasPreviewImage: sharedPreviewPath !== null,
        previewPath: sharedPreviewPath,
        knownProjectsCount: knownProjects.length,
      },
      "Calling resolveProject",
    );

    const resolution = await resolveProject({
      senderId,
      chatId: row.chatId,
      contextStore,
      messageText: row.text,
      originalFilename: row.attachmentFilename,
      knownProjects,
      lastSenderMessage,
      ...(sharedPreviewPath !== null
        ? { previewImagePath: sharedPreviewPath }
        : {}),
    });

    if (resolution.needsManualReview) {
      logger.warn(
        {
          operation: "resolveProject",
          messageRowId: row.messageRowId,
          attachmentRowId: row.attachmentRowId,
          chatId: row.chatId,
          senderId,
          originalFilename: row.attachmentFilename,
          projectName: resolution.projectName,
          source: resolution.source,
          confidence: resolution.confidence,
          reasoning: resolution.reasoning,
          hasMessageText: row.text !== null,
          hasLastSenderMessage: lastSenderMessage !== null,
          knownProjectsCount: knownProjects.length,
        },
        "Project unresolved — routing to manual review",
      );
    }

    logger.info(
      {
        operation: "resolveProject:result",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        senderId,
        projectName: resolution.projectName,
        source: resolution.source,
        confidence: resolution.confidence,
        needsManualReview: resolution.needsManualReview,
        reasoning: resolution.reasoning,
        suggestedPhase: resolution.suggestedPhase ?? null,
        suggestedLocation: resolution.suggestedLocation ?? null,
      },
      "Project resolution result",
    );

    const projectName = resolution.projectName;

    // ---- Update context store after resolution ----
    // When the project was resolved fresh (via tag or AI — not already from stored
    // context), cache it so subsequent attachments in the same chat are fast-pathed
    // without another AI call per attachment.
    if (!resolution.needsManualReview && resolution.source !== "user-context") {
      // Always update chat context so other participants benefit.
      contextStore.setChat(row.chatId, projectName, row.text ?? "");

      // Update sender context only when the attachment carried actual text —
      // writing an empty string would erase good context from an earlier message.
      if (row.text) {
        contextStore.setSender(senderId, row.text, {
          projectName,
          ...(resolution.suggestedLocation !== undefined
            ? { locationHint: resolution.suggestedLocation }
            : {}),
          ...(resolution.suggestedDescription !== undefined
            ? { descriptionHint: resolution.suggestedDescription }
            : {}),
        });
      }
    }

    void activityLog.write({
      ts: new Date().toISOString(),
      kind: resolution.needsManualReview
        ? "manual_review_routed"
        : "project_resolved",
      messageRowId: row.messageRowId,
      senderId,
      projectName,
      ...(row.attachmentFilename !== null
        ? { fileName: row.attachmentFilename }
        : {}),
      detail: `source=${resolution.source} confidence=${resolution.confidence.toFixed(2)} reasoning=${resolution.reasoning ?? ""}`,
    });

    // ---- Classification (render shortcut or AI, reusing shared preview) ----

    let classification: ClassificationResult;

    if (renderDetected) {
      classification = buildRenderClassification();
      logger.info(
        { filePath: extracted.destinationPath },
        "Render detected — skipping AI classification",
      );
    } else {
      const chatContext = contextStore.getChat(row.chatId);
      const chatHintText =
        chatContext?.projectName === null ? chatContext.rawMessageText : null;

      classification = await classifyAttachment({
        filePath: extracted.destinationPath,
        category,
        messageText: combinedMessageText,
        originalFilename: row.attachmentFilename,
        projectName,
        knownProjects,
        ...(chatHintText !== null ? { chatHintText } : {}),
        // Pass the shared preview — classifier will not clean it up.
        ...(sharedPreviewPath !== null
          ? { previewPath: sharedPreviewPath }
          : {}),
      });
    }

    // ---- Naming ----

    const naming = buildFinalNaming({
      row,
      category,
      classification,
      originalPath: extracted.destinationPath,
      ...(resolution.suggestedLocation !== undefined
        ? { suggestedLocation: resolution.suggestedLocation }
        : {}),
      ...(resolution.suggestedDescription !== undefined
        ? { suggestedDescription: resolution.suggestedDescription }
        : {}),
      ...(resolution.suggestedPhase !== undefined
        ? { suggestedPhase: resolution.suggestedPhase }
        : {}),
    });

    // ---- Target directory (strict folder existence — no auto-creation) ----

    // Low-confidence video → clear phase, route to Videos/ root folder.
    const effectivePhase =
      category === "video" &&
      classification.confidence < VIDEO_CONFIDENCE_THRESHOLD
        ? undefined
        : naming.phaseFolder;

    // Classifier action=manual_review means low confidence — escalate even if
    // the project resolver was confident.
    const classifierForcesManualReview =
      !renderDetected && classification.action === "manual_review";

    const { dir: targetDirectory, routingMode } = await resolveTargetDirectory({
      projectName: classifierForcesManualReview ? MANUAL_REVIEW_PROJECT : projectName,
      rootFolder: naming.rootFolder,
      phaseFolder: effectivePhase,
    });

    // Detect silent degradation: project was resolved but filesystem routing fell back.
    if (!resolution.needsManualReview && routingMode !== "project") {
      logger.error(
        {
          operation: "resolveTargetDirectory",
          messageRowId: row.messageRowId,
          attachmentRowId: row.attachmentRowId,
          chatId: row.chatId,
          senderId,
          resolvedProjectName: projectName,
          resolutionSource: resolution.source,
          resolutionConfidence: resolution.confidence,
          targetDirectory,
          routingMode,
          rootFolder: naming.rootFolder,
          effectivePhase: effectivePhase ?? null,
          originalFilename: row.attachmentFilename,
        },
        "Project resolved but file routed to ManualReview at filesystem level — project folder or subfolder missing",
      );
    }

    // ---- Duplicate detection ----

    const duplicate = await detectDuplicate({
      filePath: extracted.destinationPath,
      category,
    });

    // ---- Move file ----

    let finalPath: string;

    if (duplicate.isDuplicate) {
      finalPath = await moveToDirectory(
        extracted.destinationPath,
        appPaths.duplicatesDir,
        naming.fileName,
      );

      void activityLog.write({
        ts: new Date().toISOString(),
        kind: "duplicate_detected",
        messageRowId: row.messageRowId,
        senderId,
        projectName,
        fileName: naming.fileName,
        detail: `type=${duplicate.duplicateType ?? "exact"} matched=${duplicate.matchedFilePath ?? ""}`,
      });

      if (duplicate.duplicateType === "exact") {
        await duplicateAlert.send({
          projectName,
          fileName: naming.fileName,
          duplicateType: duplicate.duplicateType,
          ...(duplicate.matchedFilePath !== undefined
            ? { matchedPath: duplicate.matchedFilePath }
            : {}),
        });
      }
    } else {
      finalPath = await moveToDirectory(
        extracted.destinationPath,
        targetDirectory,
        naming.fileName,
      );
    }

    logger.info(
      {
        operation: "moveToDirectory:result",
        messageRowId: row.messageRowId,
        attachmentRowId: row.attachmentRowId,
        senderId,
        fileName: naming.fileName,
        sourcePath: extracted.destinationPath,
        targetDirectory,
        finalPath,
        routingMode,
        isDuplicate: duplicate.isDuplicate,
        duplicateType: duplicate.duplicateType ?? null,
      },
      "File moved successfully",
    );

    // ---- Metadata log ----

    try {
      await metadataLog.write({
        processedAtIso: new Date().toISOString(),
        messageRowId: row.messageRowId,
        senderId,
        projectName,
        projectResolutionSource: resolution.source,
        needsManualReview: resolution.needsManualReview || classifierForcesManualReview,
        ...(row.attachmentFilename !== null
          ? { originalFilename: row.attachmentFilename }
          : {}),
        fileName: naming.fileName,
        relativePath: finalPath,
        rootFolder: naming.rootFolder,
        ...(naming.phaseFolder !== undefined
          ? { phase: naming.phaseFolder }
          : {}),
        category,
        confidence: classification.confidence,
        isDuplicate: duplicate.isDuplicate,
        ...(duplicate.duplicateType !== undefined
          ? { duplicateType: duplicate.duplicateType }
          : {}),
        ...(duplicate.matchedFilePath !== undefined
          ? { duplicateMatchedPath: duplicate.matchedFilePath }
          : {}),
        classificationSource:
          classification.classificationSource === "ai" ? "ai" : "fallback",
      });
    } catch (err: unknown) {
      logger.error(
        {
          error: err,
          operation: "metadataLog.write",
          messageRowId: row.messageRowId,
          attachmentRowId: row.attachmentRowId,
          fileName: naming.fileName,
          finalPath,
        },
        "Metadata log write failed",
      );
    }

    void activityLog.write({
      ts: new Date().toISOString(),
      kind: "attachment_processed",
      messageRowId: row.messageRowId,
      senderId,
      projectName,
      fileName: naming.fileName,
      detail: `path=${finalPath} duplicate=${String(duplicate.isDuplicate)}`,
    });
  } finally {
    await cleanupAiPreview(sharedPreviewPath);
  }
}

// ---------------------------------------------------------------------------
// Weekly report scheduler
// ---------------------------------------------------------------------------

function scheduleWeeklyReport(): void {
  schedule(CRON_SCHEDULE, () => {
    void generateReport(appPaths.processedLogFile, getReportPeriodStart())
      .then(sendReportEmail)
      .catch((error: unknown) => {
        logger.error({ error }, "Report job failed");
      });
  });

  logger.info({ schedule: CRON_SCHEDULE }, "Report scheduled");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info(
    { pollIntervalSeconds: env.POLL_INTERVAL_SECONDS },
    "Starting archiver",
  );

  await ensureDirectories();
  scheduleWeeklyReport();
  await processNewMessages();

  setInterval(() => {
    void processNewMessages().catch((error: unknown) => {
      logger.error({ error }, "Polling cycle failed");
    });
  }, env.POLL_INTERVAL_SECONDS * 1000);
}

void main().catch((error: unknown) => {
  logger.fatal({ error }, "App failed to start");
  process.exit(1);
});

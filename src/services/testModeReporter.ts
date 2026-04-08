import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SupportedFileCategory } from "../utils/fileType.js";
import type { ClassificationResult } from "./aiClassifier.js";
import type { ProjectTrade } from "../utils/projectFolders.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestModeAiInput {
  readonly messageText: string | null;
  readonly originalFilename: string | null;
  readonly projectName: string | null;
  readonly chatHintText: string | null;
}

export interface TestModeAiOutput {
  readonly trade: ProjectTrade | null;
  readonly rootFolder: "Photos" | "Renders" | "Final";
  readonly description: string;
  readonly confidence: number;
  readonly classificationSource: string;
  readonly action: string;
  readonly suggestedProjectName?: string;
}

export interface TestModeReport {
  /** Original filename from iMessage attachment */
  readonly originalFilename: string | null;
  /** Sender initials or phone number */
  readonly senderId: string;
  /** Resolved project name */
  readonly projectName: string;
  /** Detected trade */
  readonly trade: ProjectTrade | null;
  /** Description used in filename */
  readonly description: string;
  /** File type category */
  readonly category: SupportedFileCategory;
  /** Final folder path (relative to storage root) */
  readonly folderPath: string;
  /** Final file name after rename */
  readonly finalFileName: string;
  /** Inputs fed to AI classifier */
  readonly aiInput: TestModeAiInput;
  /** Raw AI classification result */
  readonly aiOutput: TestModeAiOutput;
  /** Confidence score 0–1 */
  readonly confidence: number;
  /** Whether the file was a duplicate */
  readonly isDuplicate: boolean;
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 200;

function truncate(value: string | null | undefined, max: number = MAX_TEXT_LENGTH): string {
  if (!value) return "(none)";
  return value.length > max ? value.slice(0, max) + "…" : value;
}

function formatAiInput(input: TestModeAiInput): string {
  const parts: string[] = [];
  if (input.messageText) parts.push(`msg: "${truncate(input.messageText, 120)}"`);
  if (input.originalFilename) parts.push(`file: "${truncate(input.originalFilename, 60)}"`);
  if (input.chatHintText) parts.push(`chat: "${truncate(input.chatHintText, 80)}"`);
  if (input.projectName) parts.push(`project: "${input.projectName}"`);
  return parts.length > 0 ? parts.join(", ") : "(no context)";
}

function formatAiOutput(output: TestModeAiOutput): string {
  const obj: Record<string, unknown> = {
    trade: output.trade ?? "null",
    rootFolder: output.rootFolder,
    description: output.description,
    confidence: output.confidence,
    source: output.classificationSource,
    action: output.action,
  };
  if (output.suggestedProjectName !== undefined) {
    obj.suggestedProject = output.suggestedProjectName;
  }
  return JSON.stringify(obj, null, 2);
}

export function buildDebugMessage(report: TestModeReport): string {
  const lines: string[] = [
    "[File Processed]",
    "",
    `File: ${report.originalFilename ?? "(unnamed)"}`,
    `Sender: ${report.senderId}`,
    "",
    `Project: ${report.projectName}`,
    `Trade: ${report.trade ?? "—"}`,
    `Description: ${report.description}`,
    "",
    `Category: ${report.category}`,
    `Saved to: ${report.folderPath}`,
    "",
    `Final name: ${report.finalFileName}`,
    ...(report.isDuplicate ? ["", "⚠️ DUPLICATE — moved to duplicates folder"] : []),
    "",
    "AI Input:",
    formatAiInput(report.aiInput),
    "",
    "AI Output:",
    formatAiOutput(report.aiOutput),
    "",
    `Confidence: ${report.confidence.toFixed(2)}`,
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// iMessage sender via osascript
// ---------------------------------------------------------------------------

/**
 * Sends a plain-text message into the iMessage chat using AppleScript.
 *
 * Uses the chat's `guid` (e.g. "iMessage;+;chat123456") or just the chatId
 * integer — we look up the chat identifier from the chat display name or use
 * a direct handle. The simplest reliable approach on macOS is to target the
 * chat by its iMessage chat identifier stored in chat.db.
 *
 * @param chatGuid - The full iMessage chat GUID (e.g. "iMessage;+;+11234567890")
 *                   or a group chat ID string. Callers should look this up from DB.
 * @param text     - The message body to send.
 */
export async function sendMessageToChat(
  chatGuid: string,
  text: string,
): Promise<void> {
  // AppleScript: send message to an existing chat by its id
  const script = `
tell application "Messages"
  set targetChat to chat id "${chatGuid.replace(/"/g, '\\"')}"
  send "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}" to targetChat
end tell
`.trim();

  await execFileAsync("osascript", ["-e", script]);
}

// ---------------------------------------------------------------------------
// High-level reporter — safe wrapper
// ---------------------------------------------------------------------------

export async function sendTestModeReport(params: {
  chatGuid: string;
  report: TestModeReport;
}): Promise<void> {
  const message = buildDebugMessage(params.report);

  try {
    await sendMessageToChat(params.chatGuid, message);
    logger.info(
      {
        operation: "testMode:sendReport",
        chatGuid: params.chatGuid,
        originalFilename: params.report.originalFilename,
        finalFileName: params.report.finalFileName,
      },
      "[TEST MODE] Debug message sent to chat",
    );
  } catch (err: unknown) {
    // Never crash the pipeline — just warn.
    logger.warn(
      {
        operation: "testMode:sendReport",
        error: err,
        chatGuid: params.chatGuid,
        originalFilename: params.report.originalFilename,
      },
      "[TEST MODE] Failed to send debug message — pipeline continues",
    );
  }
}

// ---------------------------------------------------------------------------
// Helper to build TestModeAiOutput from ClassificationResult
// ---------------------------------------------------------------------------

export function classificationToAiOutput(
  result: ClassificationResult,
): TestModeAiOutput {
  return {
    trade: result.trade,
    rootFolder: result.rootFolder,
    description: result.description,
    confidence: result.confidence,
    classificationSource: result.classificationSource,
    action: result.action,
    ...(result.suggestedProjectName !== undefined
      ? { suggestedProjectName: result.suggestedProjectName }
      : {}),
  };
}

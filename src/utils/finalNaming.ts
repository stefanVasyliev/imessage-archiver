import * as path from "node:path";
import type { ClassificationResult } from "../services/aiClassifier.js";
import type { RawAttachmentRow } from "../services/pollMessages.js";
import { formatDateForFile, appleMessageDateToDate } from "./date.js";
import { sanitizeFileBaseName, sanitizePathSegment } from "./sanitize.js";
import type { SupportedFileCategory } from "./fileType.js";

export interface FinalNamingResult {
  projectFolder: string;
  phaseFolder: string;
  typeFolder: string;
  fileName: string;
  usedFallback: boolean;
}

function resolveInitials(row: RawAttachmentRow): string {
  if (row.isFromMe === 1) {
    return "SV";
  }

  const source = row.handleId?.trim();
  if (!source) {
    return "UK";
  }

  const letters = source.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (letters.length >= 2) {
    return letters.slice(0, 2);
  }

  return "UK";
}

function resolveDateString(row: RawAttachmentRow): string {
  const parsed = appleMessageDateToDate(row.messageDate);
  if (parsed) {
    return formatDateForFile(parsed);
  }

  return formatDateForFile(new Date());
}

function resolveTypeFolder(category: SupportedFileCategory): string {
  switch (category) {
    case "image":
      return "images";
    case "pdf":
      return "pdfs";
    case "video":
      return "videos";
    default:
      return "unknown";
  }
}

export function buildFinalNaming(
  row: RawAttachmentRow,
  category: SupportedFileCategory,
  classification: ClassificationResult | null,
  originalPath: string,
): FinalNamingResult {
  const ext = path.extname(originalPath).toLowerCase();
  const initials = resolveInitials(row);
  const dateString = resolveDateString(row);
  const typeFolder = resolveTypeFolder(category);

  if (!classification || classification.confidence < 0.45) {
    const fallbackBase = sanitizeFileBaseName(
      `${initials}_${dateString}_chat-${row.chatId}_msg-${row.messageRowId}_${category}`,
    );

    return {
      projectFolder: "unsorted",
      phaseFolder: "needs-review",
      typeFolder,
      fileName: `${fallbackBase}${ext}`,
      usedFallback: true,
    };
  }

  const projectFolder = sanitizePathSegment(classification.projectName);
  const phaseFolder = sanitizePathSegment(classification.phase);
  const description = sanitizeFileBaseName(classification.description);

  const fileBase = sanitizeFileBaseName(
    `${initials}_${dateString}_${projectFolder}_${description}`,
  );

  return {
    projectFolder,
    phaseFolder,
    typeFolder,
    fileName: `${fileBase}${ext}`,
    usedFallback: false,
  };
}

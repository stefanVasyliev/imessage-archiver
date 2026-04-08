import * as path from "node:path";
import type { ClassificationResult } from "../services/aiClassifier.js";
import type { RawAttachmentRow } from "../services/pollMessages.js";
import { appleMessageDateToDate } from "./date.js";
import type { SupportedFileCategory } from "./fileType.js";
import type { ProjectTrade } from "./projectFolders.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FinalNamingResult {
  readonly rootFolder: "Photos" | "Videos" | "Renders" | "Final";
  readonly tradeFolder?: ProjectTrade;
  readonly fileName: string;
}

// ---------------------------------------------------------------------------
// Sender initials mapping
// ---------------------------------------------------------------------------

const SENDER_INITIALS_MAP: Record<string, string> = {
  "+12139135312": "SV",
  "+12139135745": "OV",
  "+15042566155": "ZN",
  "+16462441090": "AG",
  "+13013008338": "K",
  "+17472724128": "KR",
};

function normalizeSenderKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// Date / initials
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}-${dd}-${yy}`;
}

function resolveInitials(row: RawAttachmentRow): string {
  if (row.isFromMe === 1) {
    return "SV";
  }

  const source = row.handleId?.trim();
  if (!source) return "UK";

  // 1. Exact match by raw value (email / phone / whatever is in handleId)
  const exactMatch = SENDER_INITIALS_MAP[normalizeSenderKey(source)];
  if (exactMatch) return exactMatch.toUpperCase();

  // 2. Match by normalized phone digits
  const sourceDigits = normalizePhoneDigits(source);
  if (sourceDigits) {
    for (const [key, initials] of Object.entries(SENDER_INITIALS_MAP)) {
      if (normalizePhoneDigits(key) === sourceDigits) {
        return initials.toUpperCase();
      }
    }
  }

  // 3. Fallback to letters from handleId if it contains a name/email-like value
  const letters = source.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (letters.length >= 2) {
    return letters.slice(0, 2);
  }

  // 4. Final fallback for unknown phone numbers
  return "UK";
}

function resolveDate(row: RawAttachmentRow): string {
  const parsed = appleMessageDateToDate(row.messageDate);
  return formatDate(parsed ?? new Date());
}

// ---------------------------------------------------------------------------
// Description normalization
// ---------------------------------------------------------------------------

function normalizeWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function isGarbageToken(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    lowered.startsWith("chat") ||
    lowered.startsWith("msg") ||
    lowered.startsWith("att") ||
    /\d{4,}/.test(lowered)
  );
}

function normalizeDescription(description: string | null): string | null {
  if (!description) return null;

  const words = normalizeWords(description).filter(
    (word) => !isGarbageToken(word),
  );

  return words.length > 0 ? words.join("_") : null;
}

// ---------------------------------------------------------------------------
// Location + remainder split
// ---------------------------------------------------------------------------

function splitDescriptionParts(normalized: string): {
  location: string;
  remainder: string | null;
} {
  const underscoreIndex = normalized.indexOf("_");

  if (underscoreIndex === -1) {
    return { location: normalized, remainder: null };
  }

  return {
    location: normalized.slice(0, underscoreIndex),
    remainder: normalized.slice(underscoreIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------

function resolveRootFolder(
  category: SupportedFileCategory,
  classification: ClassificationResult,
): "Photos" | "Videos" | "Renders" | "Final" {
  if (category === "video") return "Videos";
  return classification.rootFolder;
}

function resolveTradeFolder(
  rootFolder: "Photos" | "Videos" | "Renders" | "Final",
  classification: ClassificationResult,
): ProjectTrade | undefined {
  if (rootFolder === "Photos" || rootFolder === "Videos") {
    return classification.trade ?? undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

const GENERIC_DESCRIPTIONS = new Set([
  "ProgressPhoto",
  "SiteWalkVideo",
  "Document",
]);

export function buildFinalNaming(params: {
  row: RawAttachmentRow;
  category: SupportedFileCategory;
  classification: ClassificationResult;
  originalPath: string;
  suggestedLocation?: string;
  suggestedDescription?: string;
  suggestedTrade?: ProjectTrade;
}): FinalNamingResult {
  const ext = path.extname(params.originalPath).toLowerCase();

  const initials = resolveInitials(params.row);
  const date = resolveDate(params.row);

  let rawDescription = params.classification.description;
  if (GENERIC_DESCRIPTIONS.has(rawDescription)) {
    const hints = [params.suggestedLocation, params.suggestedDescription]
      .filter(Boolean)
      .join(" ");
    if (hints) rawDescription = hints;
  }

  const normalized = normalizeDescription(rawDescription);

  let fileName = `${initials}_${date}`;

  if (normalized !== null) {
    const { location, remainder } = splitDescriptionParts(normalized);
    fileName += `_${location}`;
    if (remainder !== null) {
      fileName += `_${remainder}`;
    }
  }

  fileName += ext;

  const rootFolder = resolveRootFolder(params.category, params.classification);
  let tradeFolder = resolveTradeFolder(rootFolder, params.classification);

  if (
    tradeFolder !== undefined &&
    params.classification.classificationSource !== "ai" &&
    params.suggestedTrade != null
  ) {
    tradeFolder = params.suggestedTrade;
  }

  return {
    rootFolder,
    ...(tradeFolder !== undefined ? { tradeFolder } : {}),
    fileName,
  };
}
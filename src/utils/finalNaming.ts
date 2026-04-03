import * as path from "node:path";
import type { ClassificationResult } from "../services/aiClassifier.js";
import type { RawAttachmentRow } from "../services/pollMessages.js";
import { appleMessageDateToDate } from "./date.js";
import type { SupportedFileCategory } from "./fileType.js";
import type { ProjectPhase } from "./projectFolders.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FinalNamingResult {
  readonly rootFolder: "Photos" | "Videos" | "Renders" | "Final";
  readonly phaseFolder?: ProjectPhase;
  readonly fileName: string;
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

  const letters = source.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return letters.length >= 2 ? letters.slice(0, 2) : "UK";
}

function resolveDate(row: RawAttachmentRow): string {
  const parsed = appleMessageDateToDate(row.messageDate);
  return formatDate(parsed ?? new Date());
}

// ---------------------------------------------------------------------------
// Description normalization
// ---------------------------------------------------------------------------

/**
 * Splits a string into PascalCase words:
 *   "ShowerheadWallPatch" → ["Showerhead", "Wall", "Patch"]
 *   "Framing_progress"   → ["Framing", "Progress"]
 *   "chat1644msg-att"    → filtered out by isGarbageToken
 */
function normalizeWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase
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

/**
 * Normalizes a raw description string into underscore-separated PascalCase
 * tokens with garbage removed. Returns null if nothing useful remains.
 *
 * "ShowerheadWallPatch" → "Showerhead_Wall_Patch"
 * "chat1644msg"         → null
 */
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

/**
 * Splits a normalized description into a location token (first word) and an
 * optional remainder (the rest).
 *
 * "Showerhead_Wall_Patch" → { location: "Showerhead", remainder: "Wall_Patch" }
 * "Framing"               → { location: "Framing",    remainder: null }
 *
 * Keeping these together eliminates the double-word bug that occurs when
 * location and the full description are derived independently.
 */
function splitDescriptionParts(normalized: string): {
  location: string;
  remainder: string | null;
} {
  const underscoreIndex = normalized.indexOf("_");

  if (underscoreIndex === -1) {
    // Single token — it is only the location; there is no remainder.
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
  return classification.folderHint;
}

/**
 * Phase is only meaningful under Photos and Videos.
 * For Renders and Final the property must be absent (exactOptionalPropertyTypes).
 */
function resolvePhaseFolder(
  rootFolder: "Photos" | "Videos" | "Renders" | "Final",
  classification: ClassificationResult,
): ProjectPhase | undefined {
  if (rootFolder === "Photos" || rootFolder === "Videos") {
    return classification.phase;
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
  suggestedPhase?: ProjectPhase;
}): FinalNamingResult {
  const ext = path.extname(params.originalPath).toLowerCase();

  const initials = resolveInitials(params.row);
  const date = resolveDate(params.row);

  // When the AI returns a generic description, enrich it with resolution hints.
  let rawDescription = params.classification.description;
  if (GENERIC_DESCRIPTIONS.has(rawDescription)) {
    const hints = [params.suggestedLocation, params.suggestedDescription]
      .filter(Boolean)
      .join(" ");
    if (hints) rawDescription = hints;
  }

  const normalized = normalizeDescription(rawDescription);

  // Build the [Initials]_[MMDDYY]_[Location]_[Description] segments.
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
  let phaseFolder = resolvePhaseFolder(rootFolder, params.classification);

  // When the classifier fell back to text-based phase detection and the project
  // resolver's AI returned a phase hint, prefer the resolver's hint.
  if (
    phaseFolder !== undefined &&
    params.classification.classificationSource !== "ai" &&
    params.suggestedPhase != null
  ) {
    phaseFolder = params.suggestedPhase;
  }

  return {
    rootFolder,
    ...(phaseFolder !== undefined ? { phaseFolder } : {}),
    fileName,
  };
}

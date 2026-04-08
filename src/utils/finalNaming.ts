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
// Description normalization — produces PascalCase, no internal underscores
// ---------------------------------------------------------------------------

const GARBAGE_PATTERNS: readonly RegExp[] = [
  /^(img|mov|jpeg|jpg|png|heic|pdf|file|photo|video|work|attachment)s?$/i,
  /^library$/i,
  /^messages$/i,
  /^attachments$/i,
  /^(chat|msg|att)\d*/i,
  /^\d{4,}$/,
];

function isGarbageToken(value: string): boolean {
  return GARBAGE_PATTERNS.some((rx) => rx.test(value));
}

/**
 * Converts any raw description string to PascalCase with no internal underscores.
 *
 * "ceiling panel"         → "CeilingPanel"
 * "sound_panel"           → "SoundPanel"
 * "Bathroom Tile Install"  → "BathroomTileInstall"
 * "ShowerheadWallPatch"    → "ShowerheadWallPatch"
 * "chat1644msg"            → null
 */
function normalizeDescriptionPascal(description: string | null): string | null {
  if (!description) return null;

  const words = description
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase / PascalCase
    .replace(/[_\-]+/g, " ")                 // underscores and dashes → spaces
    .replace(/[^a-zA-Z0-9\s]/g, " ")         // strip remaining punctuation
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !isGarbageToken(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  return words.length > 0 ? words.join("") : null; // PascalCase, no separators
}

/** Strip non-alphanumeric characters from a project name for use in a filename segment. */
function sanitizeProjectSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "");
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
  "SiteVideo",
  "ProjectRender",
  "FinalView",
  "Document",
  "Framing",
  "Electrical",
  "Plumbing",
  "HVAC",
  "Tile",
  "Finish",
  "General",
]);

export function buildFinalNaming(params: {
  row: RawAttachmentRow;
  category: SupportedFileCategory;
  classification: ClassificationResult;
  originalPath: string;
  projectName: string;
  suggestedDescription?: string;
  suggestedTrade?: ProjectTrade;
}): FinalNamingResult {
  const ext = path.extname(params.originalPath).toLowerCase();

  const initials = resolveInitials(params.row);
  const date = resolveDate(params.row);

  // 1. Pick best raw description — prefer specific AI description over generic fallback.
  let rawDescription = params.classification.description;
  if (GENERIC_DESCRIPTIONS.has(rawDescription) && params.suggestedDescription) {
    rawDescription = params.suggestedDescription;
  }

  // 2. Normalise to PascalCase, no internal underscores.
  const description = normalizeDescriptionPascal(rawDescription) ?? rawDescription;

  // 3. Build filename: [Initials]_[Date]_[Project]_[Description].[ext]
  const projectSegment = sanitizeProjectSegment(params.projectName);
  const fileName = projectSegment.length > 0
    ? `${initials}_${date}_${projectSegment}_${description}${ext}`
    : `${initials}_${date}_${description}${ext}`;

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
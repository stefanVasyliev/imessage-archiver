import * as path from "node:path";
import type { ClassificationResult } from "../services/aiClassifier.js";
import type { RawAttachmentRow } from "../services/pollMessages.js";
import { appleMessageDateToDate } from "./date.js";
import type { SupportedFileCategory } from "./fileType.js";
import type { ProjectPhase } from "./projectFolders.js";

export interface FinalNamingResult {
  readonly rootFolder: "Photos" | "Videos" | "Renders" | "Final";
  readonly phaseFolder?: ProjectPhase;
  readonly fileName: string;
}

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

  if (!source) {
    return "UK";
  }

  const letters = source.replace(/[^a-zA-Z]/g, "").toUpperCase();

  if (letters.length >= 2) {
    return letters.slice(0, 2);
  }

  return "UK";
}

function resolveDate(row: RawAttachmentRow): string {
  const parsed = appleMessageDateToDate(row.messageDate);

  if (parsed) {
    return formatDate(parsed);
  }

  return formatDate(new Date());
}

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

function normalizeDescription(
  description: string | null | undefined,
): string | null {
  if (!description) {
    return null;
  }

  const words = normalizeWords(description).filter(
    (word) => !isGarbageToken(word),
  );

  if (words.length === 0) {
    return null;
  }

  return words.join("_");
}

function resolveLocation(classification: ClassificationResult): string | null {
  const normalizedDescription = normalizeDescription(
    classification.description,
  );

  if (!normalizedDescription) {
    return null;
  }

  const firstWord = normalizedDescription.split("_")[0];

  return firstWord ?? null;
}

function resolveRootFolder(params: {
  category: SupportedFileCategory;
  classification: ClassificationResult;
}): "Photos" | "Videos" | "Renders" | "Final" {
  if (params.category === "video") {
    return "Videos";
  }

  return params.classification.folderHint;
}

function resolvePhaseFolder(params: {
  rootFolder: "Photos" | "Videos" | "Renders" | "Final";
  classification: ClassificationResult;
}): ProjectPhase | undefined {
  if (params.rootFolder === "Photos" || params.rootFolder === "Videos") {
    return params.classification.phase;
  }

  return undefined;
}

export function buildFinalNaming(params: {
  row: RawAttachmentRow;
  category: SupportedFileCategory;
  classification: ClassificationResult;
  originalPath: string;
}): FinalNamingResult {
  const ext = path.extname(params.originalPath).toLowerCase();

  const initials = resolveInitials(params.row);
  const date = resolveDate(params.row);
  const location = resolveLocation(params.classification);
  const description = normalizeDescription(params.classification.description);

  let fileName = `${initials}_${date}`;

  if (location) {
    fileName += `_${location}`;
  }

  if (description) {
    const descriptionWithoutLocation =
      location && description.startsWith(`${location}_`)
        ? description.slice(location.length + 1)
        : description;

    if (descriptionWithoutLocation) {
      fileName += `_${descriptionWithoutLocation}`;
    }
  }

  fileName += ext;

  const rootFolder = resolveRootFolder({
    category: params.category,
    classification: params.classification,
  });

  const phaseFolder = resolvePhaseFolder({
    rootFolder,
    classification: params.classification,
  });

  return {
    rootFolder,
    ...(phaseFolder !== undefined ? { phaseFolder } : {}),
    fileName,
  };
}

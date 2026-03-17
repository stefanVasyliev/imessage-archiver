import { createHash } from "node:crypto";
import fs from "fs-extra";
import * as path from "node:path";
import { imageHash } from "image-hash";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";

export type DuplicateType = "exact" | "perceptual";

export interface DuplicateCheckInput {
  readonly filePath: string;
  readonly category: "image" | "video" | "pdf" | "unknown";
}

export interface DuplicateCheckResult {
  readonly isDuplicate: boolean;
  readonly duplicateType?: DuplicateType;
  readonly matchedFilePath?: string;
  readonly sha256: string;
  readonly perceptualHash?: string;
  readonly distance?: number;
}

interface StoredHashEntry {
  readonly filePath: string;
  readonly sha256: string;
  readonly perceptualHash?: string;
  readonly category: "image" | "video" | "pdf" | "unknown";
  readonly createdAtIso: string;
}

interface DuplicateIndexFile {
  readonly version: 1;
  readonly entries: readonly StoredHashEntry[];
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const PERCEPTUAL_DISTANCE_THRESHOLD = 8;

function isSupportedImageExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function isImageCategory(category: DuplicateCheckInput["category"]): boolean {
  return category === "image";
}

function calculateSha256(fileBuffer: Buffer): string {
  return createHash("sha256").update(fileBuffer).digest("hex");
}

function calculateImagePerceptualHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    imageHash(
      filePath,
      16,
      true,
      (error: Error | null, data: string | undefined): void => {
        if (error) {
          reject(error);
          return;
        }

        if (!data || data.trim() === "") {
          reject(new Error("imageHash returned no hash value"));
          return;
        }

        resolve(data.trim().toLowerCase());
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidCategory(value: unknown): value is StoredHashEntry["category"] {
  return (
    value === "image" ||
    value === "video" ||
    value === "pdf" ||
    value === "unknown"
  );
}

function isValidStoredHashEntry(value: unknown): value is StoredHashEntry {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.filePath !== "string" || value.filePath.trim() === "") {
    return false;
  }

  if (typeof value.sha256 !== "string" || value.sha256.trim() === "") {
    return false;
  }

  if (
    value.perceptualHash !== undefined &&
    typeof value.perceptualHash !== "string"
  ) {
    return false;
  }

  if (!isValidCategory(value.category)) {
    return false;
  }

  if (
    typeof value.createdAtIso !== "string" ||
    value.createdAtIso.trim() === ""
  ) {
    return false;
  }

  return true;
}

async function readDuplicateIndex(): Promise<DuplicateIndexFile> {
  const exists = await fs.pathExists(appPaths.hashesFile);

  if (!exists) {
    return {
      version: 1,
      entries: [],
    };
  }

  const raw = await fs.readJson(appPaths.hashesFile);

  if (!isRecord(raw)) {
    logger.warn(
      { hashesFile: appPaths.hashesFile },
      "Duplicate index file is invalid, recreating",
    );

    return {
      version: 1,
      entries: [],
    };
  }

  const entriesRaw = raw.entries;
  const entries = Array.isArray(entriesRaw)
    ? entriesRaw.filter(isValidStoredHashEntry)
    : [];

  return {
    version: 1,
    entries,
  };
}

async function writeDuplicateIndex(index: DuplicateIndexFile): Promise<void> {
  await fs.ensureFile(appPaths.hashesFile);
  await fs.writeJson(appPaths.hashesFile, index, { spaces: 2 });
}

function hammingDistance(a: string, b: string): number {
  const normalizedA = a.trim().toLowerCase();
  const normalizedB = b.trim().toLowerCase();

  if (normalizedA.length !== normalizedB.length) {
    return Number.POSITIVE_INFINITY;
  }

  let distance = 0;

  for (let i = 0; i < normalizedA.length; i += 1) {
    if (normalizedA[i] !== normalizedB[i]) {
      distance += 1;
    }
  }

  return distance;
}

function findExactDuplicate(
  entries: readonly StoredHashEntry[],
  sha256: string,
): StoredHashEntry | undefined {
  return entries.find((entry) => entry.sha256 === sha256);
}

function findClosestPerceptualDuplicate(
  entries: readonly StoredHashEntry[],
  perceptualHash: string,
): { entry: StoredHashEntry; distance: number } | undefined {
  let bestMatch: { entry: StoredHashEntry; distance: number } | undefined;

  for (const entry of entries) {
    if (!entry.perceptualHash) {
      continue;
    }

    const distance = hammingDistance(perceptualHash, entry.perceptualHash);

    if (distance > PERCEPTUAL_DISTANCE_THRESHOLD) {
      continue;
    }

    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { entry, distance };
    }
  }

  return bestMatch;
}

function buildStoredHashEntry(input: {
  filePath: string;
  sha256: string;
  perceptualHash?: string;
  category: StoredHashEntry["category"];
}): StoredHashEntry {
  return {
    filePath: input.filePath,
    sha256: input.sha256,
    ...(input.perceptualHash !== undefined
      ? { perceptualHash: input.perceptualHash }
      : {}),
    category: input.category,
    createdAtIso: new Date().toISOString(),
  };
}

export async function detectDuplicate(
  input: DuplicateCheckInput,
): Promise<DuplicateCheckResult> {
  const fileBuffer = await fs.readFile(input.filePath);
  const sha256 = calculateSha256(fileBuffer);

  const index = await readDuplicateIndex();

  const exactMatch = findExactDuplicate(index.entries, sha256);

  let perceptualHash: string | undefined;

  const canUsePerceptualHash =
    isImageCategory(input.category) &&
    isSupportedImageExtension(input.filePath);

  if (!exactMatch && canUsePerceptualHash) {
    try {
      perceptualHash = await calculateImagePerceptualHash(input.filePath);
    } catch (error) {
      logger.warn(
        {
          filePath: input.filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to calculate perceptual hash",
      );
    }
  }

  let result: DuplicateCheckResult;

  if (exactMatch) {
    result = {
      isDuplicate: true,
      duplicateType: "exact",
      matchedFilePath: exactMatch.filePath,
      sha256,
    };
  } else if (perceptualHash) {
    const imageEntries = index.entries.filter(
      (entry) => entry.category === "image",
    );

    const perceptualMatch = findClosestPerceptualDuplicate(
      imageEntries,
      perceptualHash,
    );

    if (perceptualMatch) {
      result = {
        isDuplicate: true,
        duplicateType: "perceptual",
        matchedFilePath: perceptualMatch.entry.filePath,
        sha256,
        perceptualHash,
        distance: perceptualMatch.distance,
      };
    } else {
      result = {
        isDuplicate: false,
        sha256,
        perceptualHash,
      };
    }
  } else {
    result = {
      isDuplicate: false,
      sha256,
    };
  }

  const alreadyStoredByPath = index.entries.some(
    (entry) => entry.filePath === input.filePath,
  );

  if (!alreadyStoredByPath) {
    const nextEntry = buildStoredHashEntry({
      filePath: input.filePath,
      sha256,
      ...(perceptualHash !== undefined ? { perceptualHash } : {}),
      category: input.category,
    });

    await writeDuplicateIndex({
      version: 1,
      entries: [...index.entries, nextEntry],
    });
  }

  logger.debug(
    {
      filePath: input.filePath,
      category: input.category,
      isDuplicate: result.isDuplicate,
      duplicateType: result.duplicateType,
      matchedFilePath: result.matchedFilePath,
      distance: result.distance,
    },
    "Duplicate detection completed",
  );

  return result;
}

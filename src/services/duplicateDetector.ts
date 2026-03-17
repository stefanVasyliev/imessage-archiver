import { createHash } from "node:crypto";
import fs from "fs-extra";
import * as path from "node:path";
import { imageHash } from "image-hash";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type FileCategory = DuplicateCheckInput["category"];

interface StoredHashEntry {
  readonly filePath: string;
  readonly sha256: string;
  readonly perceptualHash?: string;
  readonly category: FileCategory;
  readonly createdAtIso: string;
}

interface HashIndex {
  readonly version: 1;
  readonly entries: readonly StoredHashEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERCEPTUAL_DISTANCE_THRESHOLD = 8;
const PERCEPTUAL_HASH_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const EMPTY_INDEX: HashIndex = { version: 1, entries: [] };

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function canComputePerceptualHash(filePath: string, category: FileCategory): boolean {
  return (
    category === "image" &&
    PERCEPTUAL_HASH_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}

function computePerceptualHash(filePath: string): Promise<string> {
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
        if (!data?.trim()) {
          reject(new Error("imageHash returned an empty result"));
          return;
        }
        resolve(data.trim().toLowerCase());
      },
    );
  });
}

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

function isValidEntry(value: unknown): value is StoredHashEntry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.filePath === "string" &&
    r.filePath.length > 0 &&
    typeof r.sha256 === "string" &&
    r.sha256.length > 0 &&
    (r.perceptualHash === undefined || typeof r.perceptualHash === "string") &&
    (r.category === "image" ||
      r.category === "video" ||
      r.category === "pdf" ||
      r.category === "unknown") &&
    typeof r.createdAtIso === "string" &&
    r.createdAtIso.length > 0
  );
}

async function readIndex(): Promise<HashIndex> {
  if (!(await fs.pathExists(appPaths.hashesFile))) {
    return EMPTY_INDEX;
  }

  const raw: unknown = await fs.readJson(appPaths.hashesFile);

  if (typeof raw !== "object" || raw === null) {
    logger.warn({ path: appPaths.hashesFile }, "Hash index is corrupt — recreating");
    return EMPTY_INDEX;
  }

  const entriesRaw = (raw as Record<string, unknown>).entries;
  const entries = Array.isArray(entriesRaw)
    ? entriesRaw.filter(isValidEntry)
    : [];

  return { version: 1, entries };
}

async function appendToIndex(
  index: HashIndex,
  entry: StoredHashEntry,
): Promise<void> {
  const alreadyIndexed = index.entries.some((e) => e.filePath === entry.filePath);
  if (alreadyIndexed) return;

  await fs.ensureFile(appPaths.hashesFile);
  await fs.writeJson(
    appPaths.hashesFile,
    { version: 1, entries: [...index.entries, entry] },
    { spaces: 2 },
  );
}

// ---------------------------------------------------------------------------
// Match finders
// ---------------------------------------------------------------------------

function findExactMatch(
  entries: readonly StoredHashEntry[],
  sha256: string,
): StoredHashEntry | undefined {
  return entries.find((e) => e.sha256 === sha256);
}

function findBestPerceptualMatch(
  entries: readonly StoredHashEntry[],
  phash: string,
): { entry: StoredHashEntry; distance: number } | undefined {
  let best: { entry: StoredHashEntry; distance: number } | undefined;

  for (const entry of entries) {
    if (!entry.perceptualHash) continue;
    const distance = hammingDistance(phash, entry.perceptualHash);
    if (
      distance <= PERCEPTUAL_DISTANCE_THRESHOLD &&
      (!best || distance < best.distance)
    ) {
      best = { entry, distance };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectDuplicate(
  input: DuplicateCheckInput,
): Promise<DuplicateCheckResult> {
  const buffer = await fs.readFile(input.filePath);
  const sha256 = computeSha256(buffer);
  const index = await readIndex();

  // --- 1. Exact duplicate (SHA-256) ---

  const exactMatch = findExactMatch(index.entries, sha256);

  if (exactMatch) {
    await appendToIndex(index, {
      filePath: input.filePath,
      sha256,
      category: input.category,
      createdAtIso: new Date().toISOString(),
    });

    logger.debug(
      { filePath: input.filePath, matchedFilePath: exactMatch.filePath },
      "Exact duplicate detected",
    );

    return {
      isDuplicate: true,
      duplicateType: "exact",
      matchedFilePath: exactMatch.filePath,
      sha256,
    };
  }

  // --- 2. Perceptual duplicate (image-hash + Hamming distance) ---

  let perceptualHash: string | undefined;

  if (canComputePerceptualHash(input.filePath, input.category)) {
    try {
      perceptualHash = await computePerceptualHash(input.filePath);
    } catch (error: unknown) {
      logger.warn(
        {
          filePath: input.filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Perceptual hash computation failed — skipping similarity check",
      );
    }
  }

  // Store the new entry (once, regardless of outcome below)
  await appendToIndex(index, {
    filePath: input.filePath,
    sha256,
    ...(perceptualHash !== undefined ? { perceptualHash } : {}),
    category: input.category,
    createdAtIso: new Date().toISOString(),
  });

  if (perceptualHash !== undefined) {
    const perceptualMatch = findBestPerceptualMatch(index.entries, perceptualHash);

    if (perceptualMatch) {
      logger.debug(
        {
          filePath: input.filePath,
          matchedFilePath: perceptualMatch.entry.filePath,
          distance: perceptualMatch.distance,
        },
        "Perceptual duplicate detected",
      );

      return {
        isDuplicate: true,
        duplicateType: "perceptual",
        matchedFilePath: perceptualMatch.entry.filePath,
        sha256,
        perceptualHash,
        distance: perceptualMatch.distance,
      };
    }

    return { isDuplicate: false, sha256, perceptualHash };
  }

  // --- 3. No duplicate ---

  return { isDuplicate: false, sha256 };
}

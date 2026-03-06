import fs from "fs-extra";
import * as path from "node:path";
import { imageHash } from "image-hash";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";

interface HashIndex {
  [hash: string]: string[];
}

function calculateImageHash(filePath: string): Promise<string> {
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

        if (!data) {
          reject(new Error("imageHash returned no hash value"));
          return;
        }

        resolve(data);
      },
    );
  });
}

async function readHashIndex(): Promise<HashIndex> {
  const exists = await fs.pathExists(appPaths.hashesFile);
  if (!exists) {
    return {};
  }

  return (await fs.readJson(appPaths.hashesFile)) as HashIndex;
}

async function writeHashIndex(index: HashIndex): Promise<void> {
  await fs.ensureFile(appPaths.hashesFile);
  await fs.writeJson(appPaths.hashesFile, index, { spaces: 2 });
}

export async function checkAndStoreDuplicate(
  filePath: string,
): Promise<{ isDuplicate: boolean; hash: string }> {
  const ext = path.extname(filePath).toLowerCase();

  const supported = [".jpg", ".jpeg", ".png", ".webp", ".heic"];
  if (!supported.includes(ext)) {
    return {
      isDuplicate: false,
      hash: "unsupported-file-type",
    };
  }

  const hash = await calculateImageHash(filePath);
  const index = await readHashIndex();

  const existing = index[hash] ?? [];
  const isDuplicate = existing.length > 0;

  index[hash] = [...existing, filePath];
  await writeHashIndex(index);

  logger.debug(
    {
      filePath,
      hash,
      isDuplicate,
    },
    "Duplicate check completed",
  );

  return { isDuplicate, hash };
}

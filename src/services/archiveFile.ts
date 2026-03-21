import fs from "fs-extra";
import * as path from "node:path";
import { logger } from "../utils/logger.js";

async function getUniqueDestinationPath(
  targetDirectory: string,
  fileName: string,
): Promise<string> {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);

  let candidate = path.join(targetDirectory, fileName);
  let counter = 2;

  while (await fs.pathExists(candidate)) {
    candidate = path.join(targetDirectory, `${base}_${counter}${ext}`);
    counter += 1;
  }

  return candidate;
}

export async function moveToDirectory(
  sourcePath: string,
  targetDirectory: string,
  targetFileName?: string,
): Promise<string> {
  await fs.ensureDir(targetDirectory);

  const fileName = targetFileName ?? path.basename(sourcePath);
  const destinationPath = await getUniqueDestinationPath(
    targetDirectory,
    fileName,
  );

  try {
    await fs.move(sourcePath, destinationPath, { overwrite: false });
  } catch (err: unknown) {
    logger.error(
      {
        error: err,
        operation: "moveToDirectory",
        sourcePath,
        destinationPath,
        targetDirectory,
        fileName,
      },
      "File move failed",
    );
    throw err;
  }

  return destinationPath;
}

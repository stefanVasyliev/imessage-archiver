import fs from "fs-extra";
import * as path from "node:path";

export async function moveToDirectory(
  sourcePath: string,
  targetDirectory: string,
  targetFileName?: string,
): Promise<string> {
  await fs.ensureDir(targetDirectory);

  const fileName = targetFileName ?? path.basename(sourcePath);
  const destinationPath = path.join(targetDirectory, fileName);

  await fs.move(sourcePath, destinationPath, { overwrite: true });

  return destinationPath;
}

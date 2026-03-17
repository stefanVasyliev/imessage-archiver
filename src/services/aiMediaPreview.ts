import fs from "fs-extra";
import * as path from "node:path";
import * as crypto from "node:crypto";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AiImagePreviewResult {
  previewPath: string;
  width: number;
  height: number;
  originalBytes: number;
  previewBytes: number;
}

export interface AiVideoFrameResult {
  framePath: string;
  originalBytes: number;
  frameBytes: number;
}

function buildTempName(
  prefix: string,
  sourcePath: string,
  ext: string,
): string {
  const hash = crypto
    .createHash("sha1")
    .update(sourcePath + ":" + Date.now().toString())
    .digest("hex")
    .slice(0, 12);

  return `${prefix}-${hash}${ext}`;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.ensureDir(dirPath);
}

export async function optimizeImageForAI(params: {
  inputPath: string;
  tempDir: string;
  maxWidth?: number;
  maxHeight?: number;
  jpegQuality?: number;
}): Promise<AiImagePreviewResult> {
  const {
    inputPath,
    tempDir,
    maxWidth = 1200,
    maxHeight = 1200,
    jpegQuality = 76,
  } = params;

  await ensureDir(tempDir);

  const previewPath = path.join(
    tempDir,
    buildTempName("ai-image-preview", inputPath, ".jpg"),
  );

  const originalStat = await fs.stat(inputPath);

  const image = sharp(inputPath, { failOn: "none" });
  const metadata = await image.metadata();

  await image
    .rotate()
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({
      quality: jpegQuality,
      mozjpeg: true,
    })
    .toFile(previewPath);

  const previewStat = await fs.stat(previewPath);

  return {
    previewPath,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    originalBytes: originalStat.size,
    previewBytes: previewStat.size,
  };
}

export async function extractVideoFrameForAI(params: {
  inputPath: string;
  tempDir: string;
  width?: number;
  seekSeconds?: number;
  jpegQuality?: number;
}): Promise<AiVideoFrameResult> {
  const {
    inputPath,
    tempDir,
    width = 1280,
    seekSeconds = 2,
    jpegQuality = 3, // ffmpeg scale: 2 better quality, 31 worse
  } = params;

  await ensureDir(tempDir);

  const framePath = path.join(
    tempDir,
    buildTempName("ai-video-frame", inputPath, ".jpg"),
  );

  const originalStat = await fs.stat(inputPath);

  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    String(seekSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    `scale='min(${width},iw)':-2`,
    "-q:v",
    String(jpegQuality),
    framePath,
  ]);

  const frameStat = await fs.stat(framePath);

  return {
    framePath,
    originalBytes: originalStat.size,
    frameBytes: frameStat.size,
  };
}

export async function cleanupAiPreview(
  filePath: string | null | undefined,
): Promise<void> {
  if (!filePath) {
    return;
  }

  try {
    await fs.remove(filePath);
  } catch {
    // intentionally ignore cleanup errors
  }
}

import * as path from "node:path";

export type SupportedFileCategory = "image" | "pdf" | "video" | "unknown";

const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif"
]);

const pdfExtensions = new Set([".pdf"]);

const videoExtensions = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".webm"
]);

export function getFileCategory(filePath: string): SupportedFileCategory {
  const ext = path.extname(filePath).toLowerCase();

  if (imageExtensions.has(ext)) {
    return "image";
  }

  if (pdfExtensions.has(ext)) {
    return "pdf";
  }

  if (videoExtensions.has(ext)) {
    return "video";
  }

  return "unknown";
}
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ProcessedFileEvent {
  readonly processedAtIso: string;
  readonly messageRowId: number;

  readonly projectName: string;

  readonly fileName: string;
  readonly relativePath: string;

  readonly rootFolder: "Photos" | "Videos" | "Renders" | "Final";
  readonly phaseFolder?: "Demo" | "Framing" | "Electrical" | "Finish";

  readonly category: "image" | "video" | "pdf" | "unknown";

  readonly confidence: number;

  readonly isDuplicate: boolean;
  readonly duplicateType?: "exact" | "perceptual";
  readonly duplicateMatchedPath?: string;

  readonly classificationSource:
    | "ai"
    | "video-fallback"
    | "pdf-fallback"
    | "default-fallback";
}

export function createMetadataLog(filePath: string) {
  return {
    async write(event: ProcessedFileEvent): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
    },
  };
}

import { promises as fsp } from "node:fs";
import * as path from "node:path";

export interface ProcessedFileEvent {
  readonly processedAtIso: string;
  readonly messageRowId: number;
  readonly projectName: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly rootFolder: "Photos" | "Videos" | "Renders" | "Final";
  readonly phase?: "Demo" | "Framing" | "Electrical" | "Finish";
  readonly category: "image" | "video" | "pdf" | "unknown";
  readonly confidence: number;
  readonly isDuplicate: boolean;
  readonly duplicateType?: "exact" | "perceptual";
  readonly duplicateMatchedPath?: string;
  readonly classificationSource: "ai" | "fallback";
}

export function createMetadataLog(filePath: string) {
  return {
    async write(event: ProcessedFileEvent): Promise<void> {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
    },
  };
}

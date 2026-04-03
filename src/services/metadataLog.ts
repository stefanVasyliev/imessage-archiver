import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { logger } from "../utils/logger.js";

export interface ProcessedFileEvent {
  readonly processedAtIso: string;
  readonly messageRowId: number;
  readonly senderId: string;
  readonly projectName: string;
  /** How the project was resolved: user-context | chat-context | tag | ai | fallback */
  readonly projectResolutionSource: string;
  readonly needsManualReview: boolean;
  readonly originalFilename?: string | undefined;
  readonly fileName: string;
  readonly relativePath: string;
  readonly rootFolder: "Photos" | "Videos" | "Renders" | "Final";
  readonly phase?: "Demo" | "Framing" | "Electrical" | "Plumbing" | "HVAC" | "TilePrep" | "Finish" | "Site" | "General" | undefined;
  readonly category: "image" | "video" | "pdf" | "unknown";
  readonly confidence: number;
  readonly isDuplicate: boolean;
  readonly duplicateType?: "exact" | "perceptual" | undefined;
  readonly duplicateMatchedPath?: string | undefined;
  readonly classificationSource: "ai" | "fallback";
}

export function createMetadataLog(filePath: string) {
  return {
    async write(event: ProcessedFileEvent): Promise<void> {
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
      } catch (err: unknown) {
        logger.error(
          {
            error: err,
            operation: "metadataLog.write",
            filePath,
            messageRowId: event.messageRowId,
            fileName: event.fileName,
          },
          "Metadata log write failed",
        );
        throw err;
      }
    },
  };
}

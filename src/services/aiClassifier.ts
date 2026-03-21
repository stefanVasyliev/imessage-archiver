import * as fs from "node:fs/promises";
import * as path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../config/env.js";
import { PROJECT_PHASES } from "../utils/projectFolders.js";
import type { SupportedFileCategory } from "../utils/fileType.js";
import { logger } from "../utils/logger.js";
import {
  optimizeImageForAI,
  extractVideoFrameForAI,
  cleanupAiPreview,
} from "./aiMediaPreview.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const folderHintSchema = z.enum(["Photos", "Renders", "Final"]);
const phaseSchema = z.enum(PROJECT_PHASES);

const aiResponseSchema = z.object({
  phase: phaseSchema,
  folderHint: folderHintSchema,
  description: z.string().min(1),
  // Accept any number — AI sometimes returns a percentage (e.g. 90 instead of 0.9).
  // Normalized to 0..1 after parsing.
  confidence: z.number(),
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClassificationSource =
  | "ai"
  | "video-fallback"
  | "pdf-fallback"
  | "default-fallback";

export type ClassificationResult = z.infer<typeof aiResponseSchema> & {
  readonly classificationSource: ClassificationSource;
};

// ---------------------------------------------------------------------------
// OpenAI client (lazy singleton)
// ---------------------------------------------------------------------------

let client: OpenAI | null = null;

type UserContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" };

function getClient(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Fallback helpers
// ---------------------------------------------------------------------------

function buildFallbackDescription(category: SupportedFileCategory): string {
  if (category === "video") return "SiteWalkVideo";
  if (category === "pdf") return "Document";
  return "ProgressPhoto";
}

function detectPhaseFromText(
  input: string,
): "Demo" | "Framing" | "Electrical" | "Finish" {
  const text = input.toLowerCase();

  if (
    text.includes("demo") ||
    text.includes("demolition") ||
    text.includes("tear out") ||
    text.includes("tear-out")
  ) {
    return "Demo";
  }

  if (
    text.includes("frame") ||
    text.includes("framing") ||
    text.includes("stud") ||
    text.includes("studs")
  ) {
    return "Framing";
  }

  if (
    text.includes("electrical") ||
    text.includes("wire") ||
    text.includes("wiring") ||
    text.includes("panel") ||
    text.includes("outlet") ||
    text.includes("switch") ||
    text.includes("light")
  ) {
    return "Electrical";
  }

  return "Finish";
}

function detectFolderHintFromText(
  input: string,
): "Photos" | "Renders" | "Final" {
  const text = input.toLowerCase();

  if (
    text.includes("render") ||
    text.includes("3d") ||
    text.includes("3-d") ||
    text.includes("concept")
  ) {
    return "Renders";
  }

  if (
    text.includes("final") ||
    text.includes("portfolio") ||
    text.includes("hero shot")
  ) {
    return "Final";
  }

  return "Photos";
}

function resolveFallbackSource(category: SupportedFileCategory): ClassificationSource {
  if (category === "video") return "video-fallback";
  if (category === "pdf") return "pdf-fallback";
  return "default-fallback";
}

function buildFallbackClassification(params: {
  category: SupportedFileCategory;
  messageText?: string | null;
  originalFilename?: string | null;
}): ClassificationResult {
  const context = [
    params.messageText ?? "",
    params.originalFilename ?? "",
  ].join(" ");

  return {
    phase: detectPhaseFromText(context),
    folderHint: detectFolderHintFromText(context),
    description: buildFallbackDescription(params.category),
    confidence: 0.2,
    classificationSource: resolveFallbackSource(params.category),
  };
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export async function classifyAttachment(params: {
  filePath: string;
  category: SupportedFileCategory;
  messageText?: string | null;
  originalFilename?: string | null;
  projectName?: string | null;
  /**
   * Raw informal chat message that may carry phase/location hints.
   * Passed alongside messageText for richer AI context.
   */
  chatHintText?: string | null;
  /**
   * Pre-generated image or video-frame preview path.
   * When provided the classifier reuses it and does NOT clean it up —
   * the caller is responsible for cleanup.
   */
  previewPath?: string;
}): Promise<ClassificationResult> {
  const fallback = buildFallbackClassification({
    category: params.category,
    ...(params.messageText !== undefined
      ? { messageText: params.messageText }
      : {}),
    ...(params.originalFilename !== undefined
      ? { originalFilename: params.originalFilename }
      : {}),
  });

  if (!env.OPENAI_API_KEY) {
    return fallback;
  }

  // Track the preview path and whether we own it (and therefore must clean it up).
  let aiImagePath: string | null = params.previewPath ?? null;
  const ownsPreview = params.previewPath === undefined;

  try {
    const openai = getClient();

    const userContent: UserContentItem[] = [
      {
        type: "input_text",
        text:
          `Project name is already known: ${params.projectName ?? "Unknown"}.\n` +
          `Do not invent another project name.\n` +
          `Return strict JSON only with keys: phase, folderHint, description, confidence.\n` +
          `Allowed phase values: ${PROJECT_PHASES.join(", ")}.\n` +
          `Allowed folderHint values: Photos, Renders, Final.\n` +
          `Description must be short and suitable for file naming.\n` +
          `Use PascalCase without punctuation, for example: FramingProgress, MaterialSamples, SiteWalkVideo.\n` +
          `If uncertain, make your best guess.`,
      },
      {
        type: "input_text",
        text:
          `File category: ${params.category}\n` +
          `Original filename: ${params.originalFilename ?? "Unknown"}\n` +
          `Message text: ${params.messageText ?? "None"}\n` +
          `Recent chat context: ${params.chatHintText ?? "None"}`,
      },
    ];

    // Generate preview if not already provided by the caller.
    if (aiImagePath === null && params.category === "image") {
      const preview = await optimizeImageForAI({
        inputPath: params.filePath,
        tempDir: path.join(process.cwd(), ".tmp", "ai-previews"),
        maxWidth: 1200,
        maxHeight: 1200,
        jpegQuality: 76,
      });

      aiImagePath = preview.previewPath;

      const reductionPercent =
        preview.originalBytes > 0
          ? (
              ((preview.originalBytes - preview.previewBytes) /
                preview.originalBytes) *
              100
            ).toFixed(1)
          : "0";

      logger.info(
        {
          filePath: params.filePath,
          previewPath: preview.previewPath,
          originalBytes: preview.originalBytes,
          previewBytes: preview.previewBytes,
          reductionPercent,
        },
        "Built optimized image preview for AI",
      );
    }

    if (aiImagePath === null && params.category === "video") {
      try {
        const frame = await extractVideoFrameForAI({
          inputPath: params.filePath,
          tempDir: path.join(process.cwd(), ".tmp", "ai-previews"),
          width: 1280,
          seekSeconds: 2,
        });

        aiImagePath = frame.framePath;

        logger.info(
          {
            filePath: params.filePath,
            framePath: frame.framePath,
            originalBytes: frame.originalBytes,
            frameBytes: frame.frameBytes,
          },
          "Extracted video frame for AI",
        );
      } catch (frameError: unknown) {
        logger.warn(
          { error: frameError, filePath: params.filePath },
          "Video frame extraction failed — classifying without image",
        );
      }
    }

    // Attach preview image to content if available.
    if (aiImagePath !== null) {
      const fileBuffer = await fs.readFile(aiImagePath);
      const base64Image = fileBuffer.toString("base64");
      userContent.push({
        type: "input_image",
        image_url: `data:image/jpeg;base64,${base64Image}`,
        detail: "auto",
      });
    }

    const systemPrompt = [
      "You classify construction-site attachments for a file archiver.",
      "Return valid JSON only. No markdown. No explanations.",
      "",
      "Fields:",
      "  phase      — construction phase. MUST be one of: Demo, Framing, Electrical, Finish.",
      "  folderHint — MUST be one of: Photos, Renders, Final.",
      "  description — short PascalCase label for the file name (e.g. FramingProgress, BathroomTile, SiteWalkVideo).",
      "  confidence — decimal 0.0–1.0.",
      "",
      "Phase detection rules — use ALL available context (message, chat hint, image, filename):",
      "  Demo       → demolition, tear-out, dumpster, gutted walls, bare concrete",
      "  Framing    → studs, framing, lumber, rough walls, wood structure",
      "  Electrical → wires, panels, outlets, switches, conduit, junction boxes",
      "  Finish     → tile, paint, cabinets, flooring, fixtures, trim, final look",
      "",
      "ALWAYS return a phase — never omit it. If genuinely unclear, pick the best match from visual cues.",
      "Use Finish as the last resort only if no other phase is visible.",
    ].join("\n");

    const response = await openai.responses.create({
      model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    const rawText = response.output_text;

    const parsed: unknown = JSON.parse(rawText);
    const raw = aiResponseSchema.parse(parsed);

    // Normalize confidence: AI sometimes returns a percentage (90 → 0.9).
    let confidence = raw.confidence;
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
    confidence = Math.min(1, Math.max(0, confidence));

    const result: ClassificationResult = {
      ...raw,
      confidence,
      classificationSource: "ai",
    };

    return result;
  } catch (error: unknown) {
    logger.error(
      {
        error,
        filePath: params.filePath,
        category: params.category,
        originalFilename: params.originalFilename,
        messageText: params.messageText,
        fallback,
      },
      "AI classification failed, using fallback",
    );

    return fallback;
  } finally {
    if (ownsPreview) {
      await cleanupAiPreview(aiImagePath);
    }
  }
}

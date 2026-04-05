import * as fs from "node:fs/promises";
import * as path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../config/env.js";
import { PROJECT_TRADES } from "../utils/projectFolders.js";
import type { ProjectTrade } from "../utils/projectFolders.js";
import type { SupportedFileCategory } from "../utils/fileType.js";
import { logger } from "../utils/logger.js";
import {
  optimizeImageForAI,
  extractVideoFrameForAI,
  cleanupAiPreview,
} from "./aiMediaPreview.js";

// ---------------------------------------------------------------------------
// Classification rules loader
// ---------------------------------------------------------------------------

const RULES_FILE_PATH = path.resolve(process.cwd(), "config", "classification-rules.md");

const FALLBACK_RULES = [
  "Real construction photos must never be classified as renders.",
  "Ladders, tools, debris, people, or dust = real photo.",
  "Wires alone do not mean Electrical phase unless electrical work is the main focus.",
  "Cement board, backer board, tile prep work = Finish phase when dominant.",
  "Always identify the dominant construction activity, not minor secondary details.",
  "If unsure, prefer action=manual_review.",
].join("\n");

let cachedRules: string | null = null;

async function loadClassificationRules(): Promise<string> {
  try {
    const content = await fs.readFile(RULES_FILE_PATH, "utf8");
    if (!cachedRules) {
      logger.info({ rulesFile: RULES_FILE_PATH }, "Classification rules loaded from file");
    }
    cachedRules = content.trim();
    return cachedRules;
  } catch {
    logger.warn(
      { rulesFile: RULES_FILE_PATH },
      "Classification rules file not found — using built-in fallback rules",
    );
    return FALLBACK_RULES;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Canonical response shape from the model.
const aiResponseSchema = z.object({
  project: z.string().nullable(),
  asset_type: z.enum(["Photos", "Videos", "Renders", "Final"]),
  trade: z.enum(PROJECT_TRADES).nullable(),
  // Accept any number — AI sometimes returns a percentage (e.g. 90 instead of 0.9).
  // Normalized to 0..1 after parsing.
  confidence: z.number(),
  action: z.enum(["auto_route", "manual_review"]),
  reason: z.string(),
  target_path: z.string(),
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClassificationSource =
  | "ai"
  | "video-fallback"
  | "pdf-fallback"
  | "default-fallback";

export interface ClassificationResult {
  readonly trade: ProjectTrade | null;
  readonly folderHint: "Photos" | "Renders" | "Final";
  readonly description: string;
  readonly confidence: number;
  readonly classificationSource: ClassificationSource;
  /** Model's routing verdict: auto_route = confident; manual_review = low confidence. */
  readonly action: "auto_route" | "manual_review";
  /** Model's own project opinion — may differ from resolveProject()'s result. */
  readonly classifierProject?: string | null;
  /** Full target path returned by the model — e.g. "Poolhouse/Photos/Tile". */
  readonly targetPath?: string;
}

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

function detectTradeFromText(input: string): ProjectTrade {
  const text = input.toLowerCase();

  if (
    text.includes("electrical") ||
    text.includes("panel") ||
    text.includes("outlet") ||
    text.includes("conduit") ||
    text.includes("wiring")
  ) {
    return "Electrical";
  }

  if (
    text.includes("plumbing") ||
    text.includes("drain") ||
    text.includes("supply line") ||
    text.includes("valve") ||
    text.includes("manifold")
  ) {
    return "Plumbing";
  }

  if (
    text.includes("hvac") ||
    text.includes("duct") ||
    text.includes("mechanical") ||
    text.includes("vent")
  ) {
    return "HVAC";
  }

  if (
    text.includes("tile") ||
    text.includes("cement board") ||
    text.includes("durock") ||
    text.includes("backer board") ||
    text.includes("grout") ||
    text.includes("waterproof")
  ) {
    return "Tile";
  }

  if (
    text.includes("paint") ||
    text.includes("cabinet") ||
    text.includes("flooring") ||
    text.includes("trim") ||
    text.includes("fixture") ||
    text.includes("finish")
  ) {
    return "Finish";
  }

  if (
    text.includes("demo") ||
    text.includes("demolition") ||
    text.includes("tear out") ||
    text.includes("tear-out") ||
    text.includes("frame") ||
    text.includes("framing") ||
    text.includes("stud") ||
    text.includes("studs") ||
    text.includes("structural")
  ) {
    return "Structural";
  }

  return "General";
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
    trade: detectTradeFromText(context),
    folderHint: detectFolderHintFromText(context),
    description: buildFallbackDescription(params.category),
    confidence: 0.2,
    classificationSource: resolveFallbackSource(params.category),
    action: "manual_review",
  };
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for mapping the new AI response back to legacy ClassificationResult
// ---------------------------------------------------------------------------

function assetTypeToFolderHint(
  assetType: "Photos" | "Videos" | "Renders" | "Final",
): "Photos" | "Renders" | "Final" {
  if (assetType === "Renders") return "Renders";
  if (assetType === "Final") return "Final";
  return "Photos"; // Videos and Photos both land in Photos/Videos dirs (category decides)
}

export async function classifyAttachment(params: {
  filePath: string;
  category: SupportedFileCategory;
  messageText?: string | null;
  originalFilename?: string | null;
  projectName?: string | null;
  /** Known project folder names — included in the prompt so AI can name the file correctly. */
  knownProjects?: string[];
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

  // Load classification rules from disk on every call so edits take effect
  // without restarting the app.
  const classificationRules = await loadClassificationRules();

  // Track the preview path and whether we own it (and therefore must clean it up).
  let aiImagePath: string | null = params.previewPath ?? null;
  const ownsPreview = params.previewPath === undefined;

  try {
    const openai = getClient();

    const projectList = (params.knownProjects ?? []).length > 0
      ? (params.knownProjects ?? []).map((p) => `  - ${p}`).join("\n")
      : `  - ${params.projectName ?? "Unknown"}`;

    const userContent: UserContentItem[] = [
      {
        type: "input_text",
        text: [
          `Project: ${params.projectName ?? "Unknown"}`,
          `File category: ${params.category}`,
          `Original filename: ${params.originalFilename ?? "Unknown"}`,
          `Message text: ${params.messageText ?? "None"}`,
          `Recent chat context: ${params.chatHintText ?? "None"}`,
        ].join("\n"),
      },
    ];

    const systemPrompt = [
      "You are a strict file classification engine for a construction media archive.",
      "Return valid JSON only. No markdown. No explanations outside the JSON.",
      "",
      "═══════════════════════════════════════",
      "CLASSIFICATION RULES (follow strictly):",
      "═══════════════════════════════════════",
      classificationRules,
      "",
      "═══════════════════════════════════════",
      "AVAILABLE PROJECT FOLDERS (choose EXACTLY one, verbatim casing):",
      projectList,
    ].join("\n");

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

    const raw = aiResponseSchema.parse(JSON.parse(rawText) as unknown);

    // Normalize confidence: AI sometimes returns a percentage (90 → 0.9).
    let confidence = raw.confidence;
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
    confidence = Math.min(1, Math.max(0, confidence));

    const folderHint = assetTypeToFolderHint(raw.asset_type);
    // trade must be non-null for Photos/Videos; fall back to text detection.
    const trade: ProjectTrade | null =
      raw.trade ??
      (folderHint === "Photos"
        ? detectTradeFromText([params.messageText ?? "", params.originalFilename ?? ""].join(" "))
        : null);

    const result: ClassificationResult = {
      trade,
      folderHint,
      description: buildFallbackDescription(params.category),
      confidence,
      classificationSource: "ai",
      action: raw.action,
      classifierProject: raw.project,
      targetPath: raw.target_path,
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

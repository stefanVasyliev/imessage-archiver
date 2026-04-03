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
// Classification rules loader
// ---------------------------------------------------------------------------

const RULES_FILE_PATH = path.resolve(process.cwd(), "config", "classification-rules.md");

const FALLBACK_RULES = [
  "Real construction photos must never be classified as renders.",
  "Ladders, tools, debris, people, or dust = real photo.",
  "Wires alone do not mean Electrical phase unless electrical work is the main focus.",
  "Cement board / Durock = TilePrep = Finish phase when dominant.",
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

// New canonical response shape from the model.
const aiResponseSchema = z.object({
  project: z.string().nullable(),
  asset_type: z.enum(["Photos", "Videos", "Renders", "Final", "unknown"]),
  phase: z.enum(PROJECT_PHASES).nullable(),
  suggested_filename: z.string(),
  // Accept any number — AI sometimes returns a percentage (e.g. 90 instead of 0.9).
  // Normalized to 0..1 after parsing.
  confidence: z.number(),
  action: z.enum(["auto_route", "manual_review"]),
  reason: z.string(),
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
  // Existing fields kept for backward compatibility with finalNaming / routing.
  readonly phase: (typeof PROJECT_PHASES)[number];
  readonly folderHint: "Photos" | "Renders" | "Final";
  readonly description: string;
  readonly confidence: number;
  readonly classificationSource: ClassificationSource;
  // New fields from the redesigned prompt.
  /** Full filename suggested by the model — e.g. "KR_02242026_Office_FramingProgress.jpg". */
  readonly suggestedFilename?: string;
  /** Model's routing verdict: auto_route = confident; manual_review = low confidence. */
  readonly action: "auto_route" | "manual_review";
  /** Model's own project opinion — may differ from resolveProject()'s result. */
  readonly classifierProject?: string | null;
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
  assetType: "Photos" | "Videos" | "Renders" | "Final" | "unknown",
): "Photos" | "Renders" | "Final" {
  if (assetType === "Renders") return "Renders";
  if (assetType === "Final") return "Final";
  return "Photos"; // Videos and Photos both land in Photos/Videos dirs (category decides)
}

/**
 * Extract a description token from a suggested filename like
 * "KR_02242026_ContentStudio_FramingProgress.jpg".
 * Returns everything after the second underscore, minus the extension.
 * Falls back to rawFallback when parsing fails.
 */
function descriptionFromSuggestedFilename(
  suggested: string,
  rawFallback: string,
): string {
  const base = suggested.replace(/\.[^.]+$/, ""); // strip extension
  const parts = base.split("_");
  // Format: Initials _ Date _ Location _ Description...
  if (parts.length >= 4) return parts.slice(2).join("_"); // Location_Description
  if (parts.length === 3) return parts[2] ?? rawFallback; // just Location
  return rawFallback;
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

    const senderInitials = (() => {
      const fn = params.originalFilename ?? "";
      const parts = fn.split("_");
      const first = parts[0] ?? "";
      return parts.length >= 2 && /^[A-Z]{2}$/.test(first) ? first : "XX";
    })();

    const todayStr = (() => {
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const yy = String(d.getFullYear()).slice(-2);
      return `${mm}${dd}${yy}`;
    })();

    const ext = path.extname(params.originalFilename ?? params.filePath).toLowerCase() || (params.category === "video" ? ".mp4" : ".jpg");

    const systemPrompt = [
      "You classify construction-site attachments for a file archiver.",
      "Return valid JSON only. No markdown. No explanations.",
      "",
      "═══════════════════════════════════════",
      "CLASSIFICATION RULES (follow strictly):",
      "═══════════════════════════════════════",
      classificationRules,
      "",
      "═══════════════════════════════════════",
      "AVAILABLE PROJECT FOLDERS (choose EXACTLY one, verbatim casing):",
      projectList,
      "",
      "FOLDER STRUCTURE:",
      "  [Project]/Photos/[Phase]   — construction progress photos",
      "  [Project]/Videos/[Phase]   — site walk videos",
      "  [Project]/Renders          — 3D renders, concept visuals",
      "  [Project]/Final            — portfolio / hero shots",
      "",
      "ALLOWED PHASES (for Photos and Videos only):",
      "  Demo, Framing, Electrical, Finish",
      "",
      "FILE NAMING CONVENTION:",
      "  [Initials]_[MMDDYY]_[Location]_[Description].[ext]",
      "  Examples:",
      "    KR_02242026_ContentStudio_FramingProgress.jpg",
      "    ZN_02242026_Office_MaterialSamples.jpg",
      "    DV_02242026_Greenhouse_SiteWalkVideo.mp4",
      `  Use initials "${senderInitials}", date "${todayStr}", ext "${ext}".`,
      "  Location = short place name (e.g. Office, Studio, Greenhouse).",
      "  Description = short PascalCase label (e.g. FramingProgress, TileWork, SiteWalkVideo).",
      "",
      "RETURN strict JSON with exactly these keys:",
      '  { "project": string, "asset_type": "Photos"|"Videos"|"Renders"|"Final"|"unknown",',
      '    "phase": "Demo"|"Framing"|"Electrical"|"Finish"|null,',
      '    "suggested_filename": string,',
      '    "confidence": 0.0–1.0,',
      '    "action": "auto_route"|"manual_review",',
      '    "reason": string }',
      "",
      "Set action=manual_review when confidence < 0.6 or project is unclear.",
      "ALWAYS return a phase for Photos/Videos. Use null for Renders/Final.",
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

    const parsed: unknown = JSON.parse(rawText);
    const raw = aiResponseSchema.parse(parsed);

    // Normalize confidence: AI sometimes returns a percentage (90 → 0.9).
    let confidence = raw.confidence;
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
    confidence = Math.min(1, Math.max(0, confidence));

    // Map new schema → ClassificationResult interface.
    // folderHint and description are derived for backward-compat with routing/naming.
    const folderHint = assetTypeToFolderHint(raw.asset_type);
    const description = descriptionFromSuggestedFilename(
      raw.suggested_filename,
      buildFallbackDescription(params.category),
    );
    // Phase must always be a valid ProjectPhase for Photos/Videos; fall back to Finish.
    const phase: ClassificationResult["phase"] =
      raw.phase ?? detectPhaseFromText([params.messageText ?? "", params.originalFilename ?? ""].join(" "));

    const result: ClassificationResult = {
      phase,
      folderHint,
      description,
      confidence,
      classificationSource: "ai",
      suggestedFilename: raw.suggested_filename,
      action: raw.action,
      classifierProject: raw.project,
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

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
// Classification rules loader (domain rules injected into every request)
// ---------------------------------------------------------------------------

const RULES_FILE_PATH = path.resolve(process.cwd(), "config", "classification-rules.md");

const FALLBACK_RULES = [
  "Real construction photos must never be classified as renders.",
  "Ladders, tools, debris, people, or dust = real photo (not render, not final).",
  "Wires alone do not make something Electrical — it must be the dominant work.",
  "Cement board / Durock / backer board in wet areas = Tile.",
  "Always identify the dominant construction activity, not minor secondary details.",
  "If unsure about category, use photo. If unsure about trade, use General.",
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
// AI response schema
// ---------------------------------------------------------------------------

const AI_CATEGORY = z.enum(["photo", "video", "render", "final"]);
type AiCategory = z.infer<typeof AI_CATEGORY>;

const aiResponseSchema = z.object({
  category: AI_CATEGORY,
  trade: z.enum(PROJECT_TRADES),
  // Accept percentage (90) or fraction (0.9) — normalized after parse.
  confidence: z.number(),
  reasoning: z.string(),
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
  /** auto_route = confidence ≥ 0.6; manual_review = below threshold. */
  readonly action: "auto_route" | "manual_review";
}

// ---------------------------------------------------------------------------
// OpenAI client (lazy singleton)
// ---------------------------------------------------------------------------

let client: OpenAI | null = null;

type UserContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" };

function getClient(): OpenAI {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
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

  if (text.includes("electrical") || text.includes("panel") || text.includes("conduit") || text.includes("wiring"))
    return "Electrical";
  if (text.includes("plumbing") || text.includes("drain") || text.includes("supply line") || text.includes("valve") || text.includes("manifold"))
    return "Plumbing";
  if (text.includes("hvac") || text.includes("duct") || text.includes("mechanical") || text.includes("vent"))
    return "HVAC";
  if (text.includes("tile") || text.includes("cement board") || text.includes("durock") || text.includes("backer board") || text.includes("grout") || text.includes("waterproof"))
    return "Tile";
  if (text.includes("paint") || text.includes("cabinet") || text.includes("flooring") || text.includes("trim") || text.includes("fixture") || text.includes("finish"))
    return "Finish";
  if (text.includes("demo") || text.includes("demolition") || text.includes("frame") || text.includes("framing") || text.includes("stud") || text.includes("structural"))
    return "Structural";

  return "General";
}

function detectFolderHintFromText(input: string): "Photos" | "Renders" | "Final" {
  const text = input.toLowerCase();
  if (text.includes("render") || text.includes("3d") || text.includes("concept")) return "Renders";
  if (text.includes("final") || text.includes("portfolio") || text.includes("hero shot")) return "Final";
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
  const context = [params.messageText ?? "", params.originalFilename ?? ""].join(" ");
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
// Mapping helpers
// ---------------------------------------------------------------------------

function categoryToFolderHint(category: AiCategory): "Photos" | "Renders" | "Final" {
  if (category === "render") return "Renders";
  if (category === "final") return "Final";
  return "Photos"; // photo + video both route via folderHint=Photos; actual Videos dir is chosen by SupportedFileCategory
}

function deriveAction(confidence: number): "auto_route" | "manual_review" {
  return confidence >= 0.6 ? "auto_route" : "manual_review";
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
  knownProjects?: string[];
  chatHintText?: string | null;
  /**
   * Pre-generated preview path. When provided the classifier reuses it and
   * does NOT clean it up — the caller is responsible for cleanup.
   */
  previewPath?: string;
}): Promise<ClassificationResult> {
  const fallback = buildFallbackClassification({
    category: params.category,
    ...(params.messageText !== undefined ? { messageText: params.messageText } : {}),
    ...(params.originalFilename !== undefined ? { originalFilename: params.originalFilename } : {}),
  });

  if (!env.OPENAI_API_KEY) return fallback;

  const classificationRules = await loadClassificationRules();

  let aiImagePath: string | null = params.previewPath ?? null;
  const ownsPreview = params.previewPath === undefined;

  try {
    const openai = getClient();

    // ---- Structured input payload ----

    const recentMessages: string[] = [];
    if (params.chatHintText) recentMessages.push(params.chatHintText);
    if (params.messageText) recentMessages.push(params.messageText);

    const inputPayload = {
      filename: params.originalFilename ?? "unknown",
      mimeType: params.category === "video" ? "video/mp4" : params.category === "pdf" ? "application/pdf" : "image/jpeg",
      mediaType: params.category === "video" ? "video" : params.category === "image" ? "image" : "unknown",
      messageContext: {
        lastMessage: params.messageText ?? "",
        recentMessages,
        combinedText: recentMessages.join(" "),
      },
      projectContext: {
        projectName: params.projectName ?? "Unknown",
        knownTrades: PROJECT_TRADES,
        projectType: "construction",
      },
      hasPreview: false, // updated below after preview generation
    };

    // ---- Generate preview ----

    if (aiImagePath === null && params.category === "image") {
      try {
        const preview = await optimizeImageForAI({
          inputPath: params.filePath,
          tempDir: path.join(process.cwd(), ".tmp", "ai-previews"),
          maxWidth: 1200,
          maxHeight: 1200,
          jpegQuality: 76,
        });
        aiImagePath = preview.previewPath;
        const reductionPercent = preview.originalBytes > 0
          ? (((preview.originalBytes - preview.previewBytes) / preview.originalBytes) * 100).toFixed(1)
          : "0";
        logger.info(
          { filePath: params.filePath, previewPath: preview.previewPath, originalBytes: preview.originalBytes, previewBytes: preview.previewBytes, reductionPercent },
          "Built optimized image preview for AI",
        );
      } catch (previewError: unknown) {
        logger.warn({ error: previewError, filePath: params.filePath }, "Image preview failed — classifying without image");
      }
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
          { filePath: params.filePath, framePath: frame.framePath, originalBytes: frame.originalBytes, frameBytes: frame.frameBytes },
          "Extracted video frame for AI",
        );
      } catch (frameError: unknown) {
        logger.warn({ error: frameError, filePath: params.filePath }, "Video frame extraction failed — classifying without image");
      }
    }

    const hasPreview = aiImagePath !== null;
    inputPayload.hasPreview = hasPreview;

    // ---- Build user content ----

    const userContent: UserContentItem[] = [
      { type: "input_text", text: JSON.stringify(inputPayload) },
    ];

    if (aiImagePath !== null) {
      const fileBuffer = await fs.readFile(aiImagePath);
      userContent.push({
        type: "input_image",
        image_url: `data:image/jpeg;base64,${fileBuffer.toString("base64")}`,
        detail: "auto",
      });
    }

    // ---- System prompt ----

    const systemPrompt = [
      "You are an intelligent classification engine inside a construction media archiving system.",
      "Your task is to classify files with HIGH accuracy using MULTI-LAYER CONTEXT.",
      "Return STRICT JSON only. No markdown. No text outside the JSON.",
      "",
      'RETURN exactly: { "category": "photo"|"video"|"render"|"final", "trade": "Structural"|"Electrical"|"Plumbing"|"HVAC"|"Tile"|"Finish"|"General", "confidence": 0.0-1.0, "reasoning": string }',
      "",
      "CONTEXT PRIORITY (highest to lowest):",
      "  1. Project context",
      "  2. Message context",
      "  3. Filename",
      "  4. Visual preview",
      "",
      "CATEGORY RULES:",
      "  render → 3D, CGI, concept, architectural visualization (NO real-world evidence)",
      "  final  → polished, staged, presentation-ready (NO active construction evidence)",
      "  video  → any video file",
      "  photo  → real construction progress (default for images)",
      "",
      "TRADE RULES (choose EXACTLY ONE — dominant activity only):",
      "  Structural → framing, demo, studs, rough shell, broad rough construction",
      "  Electrical → wires, panels, conduit, electrical rough-in as MAIN subject",
      "  Plumbing   → drains, supply lines, valves, manifolds as MAIN subject",
      "  HVAC       → ducts, vents, air distribution as MAIN subject",
      "  Tile       → tile, Durock/backer board, waterproofing, grout",
      "  Finish     → paint, trim, cabinets, flooring, fixtures, completed interiors",
      "  General    → mixed progress, no single trade clearly dominates",
      "",
      "CONFIDENCE:",
      "  0.9+ clear | 0.7-0.9 likely | 0.5-0.7 weak | <0.5 → use General fallback",
      "",
      "DOMAIN RULES (follow strictly):",
      classificationRules,
    ].join("\n");

    // ---- Call model ----

    const response = await openai.responses.create({
      model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: userContent },
      ],
    });

    const raw = aiResponseSchema.parse(JSON.parse(response.output_text) as unknown);

    // Normalize confidence: AI sometimes returns a percentage (90 → 0.9).
    let confidence = raw.confidence;
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
    confidence = Math.min(1, Math.max(0, confidence));

    const folderHint = categoryToFolderHint(raw.category);

    // For Renders/Final trade is irrelevant — set null. For Photos/Videos always populate.
    const trade: ProjectTrade | null =
      folderHint === "Photos"
        ? raw.trade
        : null;

    logger.info(
      {
        filePath: params.filePath,
        category: raw.category,
        trade: raw.trade,
        confidence,
        action: deriveAction(confidence),
        hasPreview,
        reasoning: raw.reasoning,
      },
      "AI classification result",
    );

    return {
      trade,
      folderHint,
      description: buildFallbackDescription(params.category),
      confidence,
      classificationSource: "ai",
      action: deriveAction(confidence),
    };
  } catch (error: unknown) {
    logger.error(
      { error, filePath: params.filePath, category: params.category, originalFilename: params.originalFilename, messageText: params.messageText, fallback },
      "AI classification failed, using fallback",
    );
    return fallback;
  } finally {
    if (ownsPreview) await cleanupAiPreview(aiImagePath);
  }
}

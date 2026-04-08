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
// Public input type
// ---------------------------------------------------------------------------

export interface AiClassificationInput {
  readonly filePath: string;
  readonly category: SupportedFileCategory;
  readonly originalFilename: string | null;
  readonly messageText: string | null;
  readonly chatHintText: string | null;
  readonly projectName: string | null;
  readonly knownProjects: readonly string[];
  /** Pre-generated preview path. When provided the classifier reuses it and
   * does NOT clean it up — the caller is responsible for cleanup. */
  readonly previewPath?: string;
}

// ---------------------------------------------------------------------------
// AI response schema  (7-field canonical output)
// ---------------------------------------------------------------------------

const AI_CATEGORY = z.enum(["photo", "video", "render", "final"]);
type AiCategory = z.infer<typeof AI_CATEGORY>;

const AI_ROOT_FOLDER = z.enum(["Photos", "Renders", "Final"]);

const aiResponseSchema = z.object({
  /** AI-suggested project name from knownProjects list (optional). */
  projectName:  z.string().nullable().optional(),
  category:     AI_CATEGORY,
  trade:        z.enum(PROJECT_TRADES),
  /** 1–3 word PascalCase/underscore description for use in filename. */
  description:  z.string().optional(),
  /** Folder bucket — AI's hint, not the final rootFolder (Videos overrides this). */
  rootFolder:   AI_ROOT_FOLDER.optional(),
  /** 0.0–1.0 or 0–100; normalized after parse. */
  confidence:   z.number(),
  reasoning:    z.string(),
});

type AiRawOutput = z.infer<typeof aiResponseSchema>;

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
  /** Folder bucket for non-video files (Videos is determined by SupportedFileCategory). */
  readonly rootFolder: "Photos" | "Renders" | "Final";
  readonly description: string;
  readonly confidence: number;
  readonly classificationSource: ClassificationSource;
  /** auto_route = confidence ≥ 0.6; manual_review = below threshold. */
  readonly action: "auto_route" | "manual_review";
  /** AI-identified project name candidate (may differ from resolver's answer). */
  readonly suggestedProjectName?: string;
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

function detectRootFolderFromText(input: string): "Photos" | "Renders" | "Final" {
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
    rootFolder: detectRootFolderFromText(context),
    description: buildFallbackDescription(params.category),
    confidence: 0.2,
    classificationSource: resolveFallbackSource(params.category),
    action: "manual_review",
  };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function categoryToRootFolder(category: AiCategory): "Photos" | "Renders" | "Final" {
  if (category === "render") return "Renders";
  if (category === "final") return "Final";
  return "Photos"; // photo + video both map to Photos; Videos dir is chosen by SupportedFileCategory
}

function deriveAction(confidence: number): "auto_route" | "manual_review" {
  return confidence >= 0.6 ? "auto_route" : "manual_review";
}

/**
 * Post-parse normalization applied to every valid AI response before it is
 * used to build a `ClassificationResult`.
 *
 * Responsibilities:
 * - Normalize confidence from percent (90) to fraction (0.9)
 * - Derive `rootFolder` from `category` when AI omitted it (single source of truth)
 * - Validate AI-suggested project name against knownProjects (discard if not recognized)
 * - Fill description fallback when AI omitted it
 */
function normalizeAiOutput(
  raw: AiRawOutput,
  category: SupportedFileCategory,
  knownProjects: readonly string[],
): {
  confidence: number;
  rootFolder: "Photos" | "Renders" | "Final";
  description: string;
  suggestedProjectName: string | undefined;
} {
  // 1. Confidence: normalize percent → fraction.
  let confidence = raw.confidence;
  if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
  confidence = Math.min(1, Math.max(0, confidence));

  // 2. rootFolder: AI hint or derive from category.
  //    AI-provided rootFolder is advisory; always re-derive for video (SupportedFileCategory wins in finalNaming).
  const rootFolder: "Photos" | "Renders" | "Final" =
    raw.rootFolder ?? categoryToRootFolder(raw.category);

  // 3. Description: use AI's value when it looks usable; otherwise fallback.
  const rawDesc = raw.description?.trim() ?? "";
  const description =
    rawDesc.length > 0 && rawDesc.length <= 80
      ? rawDesc
      : buildFallbackDescription(category);

  // 4. Project name: only pass through when it matches a known project (case-insensitive).
  const rawProject = raw.projectName?.trim() ?? "";
  const lowerKnown = knownProjects.map((p) => p.toLowerCase());
  const suggestedProjectName =
    rawProject.length > 0 && lowerKnown.includes(rawProject.toLowerCase())
      ? rawProject
      : undefined;

  return { confidence, rootFolder, description, suggestedProjectName };
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export async function classifyAttachment(
  params: AiClassificationInput,
): Promise<ClassificationResult> {
  const fallback = buildFallbackClassification({
    category: params.category,
    messageText: params.messageText,
    originalFilename: params.originalFilename,
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
        knownProjects: params.knownProjects,
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

    const knownProjectsList = params.knownProjects.length > 0
      ? params.knownProjects.join(", ")
      : "none provided";

    const systemPrompt = [
      "You are an intelligent classification engine inside a construction media archiving system.",
      "Your task is to classify files with HIGH accuracy using MULTI-LAYER CONTEXT.",
      "Return STRICT JSON only. No markdown. No text outside the JSON.",
      "",
      "RETURN exactly:",
      '{ "projectName": string|null, "category": "photo"|"video"|"render"|"final",',
      '  "trade": "Structural"|"Electrical"|"Plumbing"|"HVAC"|"Tile"|"Finish"|"General",',
      '  "description": "1-3 word PascalCase_underscore label for filename",',
      '  "rootFolder": "Photos"|"Renders"|"Final",',
      '  "confidence": 0.0-1.0, "reasoning": string }',
      "",
      `KNOWN PROJECTS (use exact spelling if you identify one): ${knownProjectsList}`,
      "",
      "CONTEXT PRIORITY (highest to lowest):",
      "  1. Project context",
      "  2. Message context",
      "  3. Filename",
      "  4. Visual preview",
      "",
      "FIELD RULES:",
      "  projectName → exact name from KNOWN PROJECTS list if identifiable, otherwise null",
      "  category    → photo | video | render | final (see rules below)",
      "  trade       → dominant construction trade (see rules below)",
      "  description → 1-3 words, PascalCase separated by underscores, e.g. Shower_Tile_Install",
      "  rootFolder  → Photos for photo/video, Renders for render, Final for final",
      "  confidence  → 0.9+ clear | 0.7-0.9 likely | 0.5-0.7 weak | <0.5 → use General/Photos",
      "  reasoning   → brief explanation of classification decision",
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

    // ---- Parse raw JSON ----

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(response.output_text) as unknown;
    } catch {
      throw new Error(`AI returned non-JSON: ${response.output_text.slice(0, 200)}`);
    }

    // ---- Pre-parse normalization ----
    // Coerce known deviations before Zod validation to avoid hard failures.

    if (typeof rawJson === "object" && rawJson !== null) {
      const obj = rawJson as Record<string, unknown>;
      // "image" is not in the schema — normalize to canonical "photo".
      if (obj.category === "image") obj.category = "photo";
      // Inject reasoning when absent so Zod doesn't reject the whole response.
      if (typeof obj.reasoning !== "string" || !obj.reasoning.trim()) {
        obj.reasoning = "No reasoning provided by model";
      }
    }

    const parseResult = aiResponseSchema.safeParse(rawJson);
    if (!parseResult.success) {
      logger.warn(
        {
          filePath: params.filePath,
          issues: parseResult.error.issues,
          rawJson,
        },
        "AI response failed schema validation — using fallback",
      );
      return fallback;
    }

    // ---- Post-parse normalization ----

    const { confidence, rootFolder, description, suggestedProjectName } =
      normalizeAiOutput(parseResult.data, params.category, params.knownProjects);

    const raw = parseResult.data;

    // For Renders/Final trade is irrelevant — set null. For Photos/Videos always populate.
    const trade: ProjectTrade | null =
      rootFolder === "Photos" ? raw.trade : null;

    logger.info(
      {
        filePath: params.filePath,
        category: raw.category,
        trade: raw.trade,
        rootFolder,
        description,
        confidence,
        action: deriveAction(confidence),
        suggestedProjectName,
        hasPreview,
        reasoning: raw.reasoning,
      },
      "AI classification result",
    );

    return {
      trade,
      rootFolder,
      description,
      confidence,
      classificationSource: "ai",
      action: deriveAction(confidence),
      ...(suggestedProjectName !== undefined ? { suggestedProjectName } : {}),
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

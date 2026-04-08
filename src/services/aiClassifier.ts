import * as fs from "node:fs/promises";
import * as path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../config/env.js";
import { PROJECT_TRADES } from "../utils/projectFolders.js";
import type { ProjectTrade } from "../utils/projectFolders.js";
import type { SupportedFileCategory } from "../utils/fileType.js";
import { logger } from "../utils/logger.js";

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
}

// ---------------------------------------------------------------------------
// Raw AI response schema — matches classification-rules.md output contract
// ---------------------------------------------------------------------------

// The rules file instructs the AI to use these capitalised asset_type values.
const RAW_ASSET_TYPE = z.enum(["Photos", "Videos", "Renders", "Final"]);

const rawAiResponseSchema = z.object({
  /** Matched project name from the known-projects list. */
  project:     z.string().nullable().optional(),
  /** Capitalised asset bucket — matches rules file `category` field. */
  category:    RAW_ASSET_TYPE,
  trade:       z.string().nullable().optional(),
  /** PascalCase description for use in filename. */
  description: z.string().optional(),
  /** 0.0–1.0 or 0–100; normalised after parse. */
  confidence:  z.number(),
  action:      z.enum(["auto_route", "manual_review"]).optional(),
  reason:      z.string().optional(),
  target_path: z.string().optional(),
  // Legacy / alternative field names the model may return
  reasoning:   z.string().optional(),
  projectName: z.string().nullable().optional(),
  rootFolder:  z.enum(["Photos", "Videos", "Renders", "Final"]).optional(),
});

type RawAiResult = z.infer<typeof rawAiResponseSchema>;

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

function assetTypeToRootFolder(
  assetType: "Photos" | "Videos" | "Renders" | "Final",
): "Photos" | "Renders" | "Final" {
  if (assetType === "Renders") return "Renders";
  if (assetType === "Final") return "Final";
  return "Photos"; // Photos + Videos both map to Photos; Videos dir is chosen by SupportedFileCategory
}

function deriveAction(confidence: number): "auto_route" | "manual_review" {
  return confidence >= 0.6 ? "auto_route" : "manual_review";
}

const VALID_TRADES = new Set<string>(PROJECT_TRADES);

function coerceTrade(raw: string | null | undefined): ProjectTrade {
  if (raw && VALID_TRADES.has(raw)) return raw as ProjectTrade;
  return "General";
}

/**
 * Maps the raw AI response (rules-file format) to the internal pipeline format.
 *
 * Handles both the canonical rules-file schema (`project`, `category` as
 * "Photos"|"Videos"|…, `reason`) and legacy/alternative field names the model
 * may emit (`projectName`, `rootFolder`, `reasoning`).
 *
 * Never throws — recovers all fields with safe defaults.
 */
export function normalizeAiResult(
  raw: RawAiResult,
  fileCategory: SupportedFileCategory,
  knownProjects: readonly string[],
): {
  confidence: number;
  rootFolder: "Photos" | "Renders" | "Final";
  trade: ProjectTrade;
  description: string;
  reasoning: string;
  suggestedProjectName: string | undefined;
} {
  // 1. Confidence: normalize percent → fraction.
  let confidence = raw.confidence ?? 0;
  if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
  confidence = Math.min(1, Math.max(0, confidence));

  // 2. rootFolder: derive from asset_type / category field.
  //    Support both new rules-file field (`category` = "Photos"|…) and legacy `rootFolder`.
  const assetType: "Photos" | "Videos" | "Renders" | "Final" =
    raw.rootFolder ?? raw.category;
  const rootFolder = assetTypeToRootFolder(assetType);

  // 3. Trade: coerce to valid value; null → "General".
  const trade = coerceTrade(raw.trade);

  // 4. Description: AI value → trade fallback → media fallback.
  const rawDesc = (raw.description ?? "").trim();
  let description: string;
  if (rawDesc.length > 0 && rawDesc.length <= 80 && !isDescriptionJunk(rawDesc)) {
    description = rawDesc;
  } else if (trade !== "General") {
    description = tradeToDescriptionFallback(trade);
  } else {
    description = mediaFallbackDescription(fileCategory, assetType);
  }

  // 5. Reasoning: `reason` (rules-file) → `reasoning` (legacy) → default.
  const reasoning =
    (raw.reason ?? raw.reasoning ?? "").trim() || "Recovered from AI response";

  // 6. Project name: validate against knownProjects.
  const rawProject = (raw.project ?? raw.projectName ?? "").trim();
  const lowerKnown = knownProjects.map((p) => p.toLowerCase());
  const suggestedProjectName =
    rawProject.length > 0 && lowerKnown.includes(rawProject.toLowerCase())
      ? rawProject
      : undefined;

  return { confidence, rootFolder, trade, description, reasoning, suggestedProjectName };
}

// ---------------------------------------------------------------------------
// Description helpers
// ---------------------------------------------------------------------------

const JUNK_PATTERNS = [
  /^(img|mov|jpeg|jpg|png|heic|pdf|file|photo|video|work|attachment)s?$/i,
  /^library$/i,
  /^messages$/i,
  /^attachments$/i,
  /^(chat|msg|att)\d*/i,
  /^\d{4,}$/,
];

function isDescriptionJunk(value: string): boolean {
  const tokens = value.toLowerCase().split(/[\s_-]+/);
  return tokens.every((t) => JUNK_PATTERNS.some((rx) => rx.test(t)));
}

function tradeToDescriptionFallback(trade: ProjectTrade): string {
  if (trade === "Structural") return "Framing";
  return trade; // Electrical, Plumbing, HVAC, Tile, Finish, General are self-describing
}

function mediaFallbackDescription(
  fileCategory: SupportedFileCategory,
  assetType: "Photos" | "Videos" | "Renders" | "Final",
): string {
  if (assetType === "Renders") return "ProjectRender";
  if (assetType === "Final") return "FinalView";
  if (fileCategory === "video") return "SiteVideo";
  if (fileCategory === "pdf") return "Document";
  return "ProgressPhoto";
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

  try {
    const openai = getClient();

    // ---- Structured text payload ----

    const recentMessages: string[] = [];
    if (params.chatHintText) recentMessages.push(params.chatHintText);
    if (params.messageText) recentMessages.push(params.messageText);

    const canSendImage = params.category === "image" || params.category === "video";
    const mimeType = params.category === "video" ? "video/mp4"
      : params.category === "pdf" ? "application/pdf"
      : "image/jpeg";

    const inputPayload = {
      filename: params.originalFilename ?? "unknown",
      mimeType,
      mediaType: params.category === "video" ? "video" : params.category === "image" ? "image" : params.category,
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
    };

    // ---- Send original file directly ----

    const userContent: UserContentItem[] = [
      { type: "input_text", text: JSON.stringify(inputPayload) },
    ];

    if (canSendImage) {
      try {
        const stat = await fs.stat(params.filePath);
        const fileBuffer = await fs.readFile(params.filePath);
        logger.info(
          { operation: "ai:sendOriginalFile", filePath: params.filePath, mimeType, sizeBytes: stat.size },
          "[ai] sending original file",
        );
        userContent.push({
          type: "input_image",
          image_url: `data:image/jpeg;base64,${fileBuffer.toString("base64")}`,
          detail: "auto",
        });
      } catch (readErr: unknown) {
        logger.warn(
          { error: readErr, filePath: params.filePath },
          "[ai] could not read original file — classifying from text context only",
        );
      }
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
      '{',
      '  "project": "string or null",',
      '  "category": "Photos" | "Videos" | "Renders" | "Final",',
      '  "trade": "Structural" | "Electrical" | "Plumbing" | "HVAC" | "Tile" | "Finish" | "General" | null,',
      '  "description": "PascalCase label for filename — no spaces, no underscores inside the phrase",',
      '  "confidence": 0.0-1.0,',
      '  "action": "auto_route" | "manual_review",',
      '  "reason": "short explanation",',
      '  "target_path": "Project/Category/Trade or Project/Renders or Project/Final"',
      '}',
      "",
      `KNOWN PROJECTS (use exact spelling if you identify one): ${knownProjectsList}`,
      "",
      "FIELD RULES:",
      "  project     → exact name from KNOWN PROJECTS list if identifiable, otherwise null",
      "  category    → Photos | Videos | Renders | Final",
      "  trade       → dominant construction trade for Photos/Videos; null for Renders/Final",
      "  description → PascalCase, no spaces, no underscores inside phrase",
      "                e.g. CeilingPanel, BathroomTileInstall, Framing, ProgressPhoto",
      "                Priority: specific subject → trade fallback → media fallback",
      "                Structural fallback: Framing",
      "                Media fallbacks: ProgressPhoto / SiteVideo / ProjectRender / FinalView",
      "  confidence  → 0.9+ clear | 0.75-0.89 likely | 0.6-0.74 uncertain | <0.6 weak",
      "  action      → auto_route when project + category are clear; otherwise manual_review",
      "  reason      → brief explanation of classification decision",
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
    // Coerce legacy field names before Zod validation to avoid hard failures.

    if (typeof rawJson === "object" && rawJson !== null) {
      const obj = rawJson as Record<string, unknown>;
      // Lowercase category values → capitalise to match rules-file schema.
      const catMap: Record<string, string> = {
        photo: "Photos", photos: "Photos",
        video: "Videos", videos: "Videos",
        render: "Renders", renders: "Renders",
        final: "Final",
        image: "Photos", // legacy alias
      };
      if (typeof obj.category === "string" && obj.category.toLowerCase() in catMap) {
        obj.category = catMap[obj.category.toLowerCase()];
      }
    }

    const parseResult = rawAiResponseSchema.safeParse(rawJson);
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

    // ---- Normalization: rules-file format → internal pipeline format ----

    const { confidence, rootFolder, trade: normalizedTrade, description, reasoning, suggestedProjectName } =
      normalizeAiResult(parseResult.data, params.category, params.knownProjects);

    // For Renders/Final trade is irrelevant — set null. For Photos/Videos always populate.
    const trade: ProjectTrade | null =
      rootFolder === "Photos" ? normalizedTrade : null;

    logger.info(
      {
        filePath: params.filePath,
        rawCategory: parseResult.data.category,
        trade: normalizedTrade,
        rootFolder,
        description,
        confidence,
        action: deriveAction(confidence),
        suggestedProjectName,
        reasoning,
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
  }
}

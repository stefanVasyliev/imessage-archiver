import * as fsNode from "node:fs/promises";
import * as path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../config/env.js";
import { appPaths } from "../utils/filePaths.js";
import { normalizeProjectName } from "../utils/projectFolders.js";
import { logger } from "../utils/logger.js";
import type { UserContextStore } from "./userContextStore.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProjectResolutionSource =
  | "user-context"
  | "tag"
  | "folder-match"
  | "ai"
  | "fallback";

export interface ProjectResolution {
  readonly projectName: string;
  readonly source: ProjectResolutionSource;
  readonly confidence: number;
  readonly needsManualReview: boolean;
  readonly reasoning?: string;
  /** Optional hints returned by AI — used downstream for naming/routing. */
  readonly suggestedLocation?: string;
  readonly suggestedDescription?: string;
  readonly suggestedPhase?: "Demo" | "Framing" | "Electrical" | "Finish";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files that cannot be resolved are routed here. */
export const MANUAL_REVIEW_PROJECT = "ManualReview";

const AI_CONFIDENCE_THRESHOLD = 0.6;

/** Top-level directories that are infrastructure, not projects. */
const EXCLUDED_DIRS = new Set([
  "duplicates",
  "logs",
  "reports",
  MANUAL_REVIEW_PROJECT,
]);

// ---------------------------------------------------------------------------
// Tag parsing
//
// Supported formats (case-insensitive):
//   [Project: ContentStudio]
//   Project: ContentStudio
//   #project ContentStudio
// ---------------------------------------------------------------------------

const TAG_PATTERNS: RegExp[] = [
  /\[project:\s*([^\]\n]+)\]/i,
  /^project:\s*(.+)$/im,
  /#project\s+([^\s,\n]+)/i,
];

export function parseProjectTag(text: string): string | null {
  for (const pattern of TAG_PATTERNS) {
    const match = pattern.exec(text);
    const name = match?.[1]?.trim();
    if (name) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Known project discovery
// ---------------------------------------------------------------------------

export async function getKnownProjects(): Promise<string[]> {
  try {
    const entries = await fsNode.readdir(appPaths.root, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !EXCLUDED_DIRS.has(e.name),
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Folder-name fuzzy matching
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Splits a project folder name into lowercase word tokens (≥ 3 chars).
 * "Office_OrangeCounty_ModernRed" → ["office", "orange", "county", "modern", "red"]
 */
function getProjectWordTokens(project: string): string[] {
  return project
    .replace(/([a-z])([A-Z])/g, "$1 $2") // split PascalCase
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/**
 * Matches a message against known project folder names using two tiers:
 *
 * Tier 1 — full-name substring: the normalized message contains the normalized
 *           project name as a continuous substring (original behavior).
 *
 * Tier 2 — word-token overlap: ≥ 2 of the project's significant words appear
 *           in the message text.  This lets "Office Orange County" match
 *           "Office_OrangeCounty_ModernRed" without requiring AI.
 *
 * The longest-name project wins when multiple candidates qualify.
 */
export function findMatchingProject(
  text: string,
  knownProjects: string[],
): string | null {
  const normalizedText = normalize(text);
  const sorted = [...knownProjects].sort((a, b) => b.length - a.length);

  // Tier 1: full-name substring (fast path, existing behavior).
  for (const project of sorted) {
    if (normalizedText.includes(normalize(project))) return project;
    const normalizedFolder = normalize(normalizeProjectName(project));
    if (normalizedText.includes(normalizedFolder)) return project;
  }

  // Tier 2: word-token overlap — pick the project with the most word matches,
  // requiring at least 2 matches to avoid false positives on common words.
  const textWords = new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );

  let bestProject: string | null = null;
  let bestOverlap = 0;

  for (const project of sorted) {
    const projectWords = getProjectWordTokens(project);
    const overlap = projectWords.filter((w) => textWords.has(w)).length;
    if (overlap >= 2 && overlap > bestOverlap) {
      bestProject = project;
      bestOverlap = overlap;
    }
  }

  return bestProject;
}

// ---------------------------------------------------------------------------
// AI-based project inference
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return openaiClient;
}

type TextItem = { type: "input_text"; text: string };
type ImageItem = { type: "input_image"; image_url: string; detail: "auto" };
type ContentItem = TextItem | ImageItem;

const aiProjectSchema = z.object({
  projectName: z.string().nullable(),
  // Accept any number — AI sometimes returns percentage (e.g. 90 instead of 0.9).
  // Normalized to 0..1 after parsing.
  confidence: z.number(),
  reasoning: z.string(),
  suggestedLocation: z.string().optional(),
  suggestedDescription: z.string().optional(),
  suggestedPhase: z
    .enum(["Demo", "Framing", "Electrical", "Finish"])
    .nullable()
    .optional(),
});

type AiProjectResult = z.infer<typeof aiProjectSchema>;

// Normalize AI confidence to 0..1.
// If the model returns a percentage (e.g. 90), divide by 100.
function normalizeConfidence(raw: number): number {
  let c = raw;
  if (c > 1 && c <= 100) {
    logger.debug(
      { rawConfidence: raw, normalized: raw / 100 },
      "AI confidence normalized from percent to fraction",
    );
    c = raw / 100;
  }
  return Math.min(1, Math.max(0, c));
}

async function inferProjectViaAI(params: {
  messageText: string | null;
  /** Pre-resolved context text from sender or chat store (a previously matched message). */
  contextMessageText: string | null;
  /**
   * Recent unresolved chat messages (oldest first, up to 5).
   * Builders typically say the project name in a text message before sending photos,
   * so earlier messages in the list may carry the key project hint.
   */
  recentChatMessages: string[];
  originalFilename: string | null;
  knownProjects: string[];
  previewImagePath: string | null;
}): Promise<AiProjectResult> {
  if (params.knownProjects.length === 0) {
    return {
      projectName: null,
      confidence: 0,
      reasoning: "No known projects available",
    };
  }

  const client = getOpenAIClient();

  // ---- System prompt with structured project list ----
  const systemPrompt = [
    "You are a file router for a construction company.",
    "",
    "KNOWN PROJECT FOLDERS (choose EXACTLY one, verbatim casing):",
    ...params.knownProjects.map((p) => `  - ${p}`),
    "",
    "TASK: Decide which project folder this attachment belongs to.",
    "",
    "HOW TO MATCH INFORMAL PROJECT REFERENCES:",
    "  Builders often use short, informal names — match by key words, not exact folder name.",
    "  Examples:",
    "    'woodland' or 'woodland hills'  → project containing 'Woodland' or 'WoodlandHills'",
    "    'orange county' or 'oc office'  → project containing 'OrangeCounty' or 'Orange'",
    "    'gold style' or 'gold'          → project containing 'GoldStyle' or 'Gold'",
    "    'red office' or 'modern red'    → project containing 'ModernRed' or 'Red'",
    "    'studio' or 'content studio'    → project containing 'Studio'",
    "    'office orange county'          → project containing 'Office' + 'OrangeCounty'",
    "",
    "RULES:",
    "  1. Return EXACTLY one project name from the list above — same casing, verbatim.",
    "  2. NEVER invent a project name not in the list.",
    "  3. Recent chat messages are the STRONGEST signal — use them first.",
    "  4. Image content is a weaker signal — use it only when text context is absent.",
    "  5. Return confidence as a decimal 0.0–1.0.",
    "  6. If you cannot identify the project with ≥ 0.6 confidence, return null.",
    "",
    'Return strict JSON: { "projectName": string | null, "confidence": number, "reasoning": string, "suggestedLocation"?: string, "suggestedDescription"?: string, "suggestedPhase"?: "Demo" | "Framing" | "Electrical" | "Finish" | null }',
  ].join("\n");

  // ---- User content: structured context block ----
  const contextLines: string[] = [];

  if (params.recentChatMessages.length > 0) {
    contextLines.push("RECENT CHAT MESSAGES (oldest to newest):");
    params.recentChatMessages.forEach((msg, i) => {
      contextLines.push(`  [${i + 1}] "${msg}"`);
    });
  }

  if (params.contextMessageText) {
    contextLines.push(`LAST RESOLVED CONTEXT: "${params.contextMessageText}"`);
  }

  if (params.messageText) {
    contextLines.push(`MESSAGE SENT WITH FILE: "${params.messageText}"`);
  }

  if (params.originalFilename) {
    contextLines.push(`FILENAME: ${path.basename(params.originalFilename)}`);
  }

  const userContent: ContentItem[] = [
    {
      type: "input_text",
      text: contextLines.join("\n") || "No context available.",
    },
  ];

  if (params.previewImagePath !== null) {
    try {
      const buffer = await fsNode.readFile(params.previewImagePath);
      const base64 = buffer.toString("base64");
      userContent.push({
        type: "input_image",
        image_url: `data:image/jpeg;base64,${base64}`,
        detail: "auto",
      });
    } catch (err: unknown) {
      logger.warn(
        { error: err, previewImagePath: params.previewImagePath },
        "Could not read preview image for project AI inference — proceeding without it",
      );
    }
  }

  const response = await client.responses.create({
    model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      { role: "user", content: userContent },
    ],
  });

  const parsed: unknown = JSON.parse(response.output_text);
  const raw = aiProjectSchema.parse(parsed);
  const confidence = normalizeConfidence(raw.confidence);

  // Hard validation: reject hallucinated project names.
  if (
    raw.projectName !== null &&
    !params.knownProjects.includes(raw.projectName)
  ) {
    logger.warn(
      { projectName: raw.projectName, knownProjects: params.knownProjects },
      "AI returned a project name not in the known list — ignoring",
    );
    return {
      projectName: null,
      confidence: 0,
      reasoning: "AI returned unknown project name",
    };
  }

  return { ...raw, confidence };
}

// ---------------------------------------------------------------------------
// Main resolver — priority:
//   1. Sender-specific context (10-min TTL)
//   2. Chat-level context (10-min TTL, covers all chat participants)
//   3. Explicit project tag in current message
//   4. AI inference using full context (text + image/video frame)
//   5. Manual Review fallback
// ---------------------------------------------------------------------------

export async function resolveProject(params: {
  senderId: string;
  chatId: number;
  contextStore: UserContextStore;
  messageText: string | null;
  originalFilename: string | null;
  knownProjects: string[];
  /** Pre-generated image or video-frame preview path — caller owns cleanup. */
  previewImagePath?: string;
}): Promise<ProjectResolution> {
  const previewImagePath = params.previewImagePath ?? null;

  // 1. Sender-specific context — must be a currently known project.
  const senderContext = params.contextStore.get(params.senderId);
  if (senderContext !== null) {
    if (params.knownProjects.includes(senderContext.projectName)) {
      logger.info(
        {
          senderId: params.senderId,
          projectName: senderContext.projectName,
          source: "user-context",
        },
        "Project resolved from sender context",
      );
      return {
        projectName: senderContext.projectName,
        source: "user-context",
        confidence: 0.95,
        needsManualReview: false,
        reasoning: `Active sender context for "${params.senderId}"`,
      };
    }
    logger.warn(
      { senderId: params.senderId, contextProject: senderContext.projectName },
      "Sender context project not in known folders — falling through",
    );
  }

  // 2. Chat-level context — covers attachments from any participant in the chat.
  const chatContext = params.contextStore.getChat(params.chatId);
  if (chatContext !== null && chatContext.projectName !== null) {
    if (params.knownProjects.includes(chatContext.projectName)) {
      logger.info(
        {
          chatId: params.chatId,
          senderId: params.senderId,
          projectName: chatContext.projectName,
          source: "chat-context",
        },
        "Project resolved from chat context",
      );
      return {
        projectName: chatContext.projectName,
        source: "user-context",
        confidence: 0.9,
        needsManualReview: false,
        reasoning: `Active chat context for chat ${params.chatId}`,
      };
    }
    logger.warn(
      { chatId: params.chatId, contextProject: chatContext.projectName },
      "Chat context project not in known folders — falling through",
    );
  }

  // 3. Explicit project tag — validated against knownProjects.
  if (params.messageText) {
    const tag = parseProjectTag(params.messageText);
    if (tag) {
      if (params.knownProjects.includes(tag)) {
        return {
          projectName: tag,
          source: "tag",
          confidence: 1.0,
          needsManualReview: false,
          reasoning: `Explicit tag matched existing project: "${tag}"`,
        };
      }
      const loose = findMatchingProject(tag, params.knownProjects);
      if (loose !== null) {
        return {
          projectName: loose,
          source: "tag",
          confidence: 0.9,
          needsManualReview: false,
          reasoning: `Tag "${tag}" loosely matched existing project "${loose}"`,
        };
      }
      logger.warn(
        { tag, knownProjects: params.knownProjects },
        "Project tag not found in known projects — routing to Manual Review",
      );
      return {
        projectName: MANUAL_REVIEW_PROJECT,
        source: "fallback",
        confidence: 0,
        needsManualReview: true,
        reasoning: `Tag "${tag}" does not match any known project`,
      };
    }
  }

  // 4. AI inference — full context: text + sender/chat context + raw hint + image/video frame.
  if (env.OPENAI_API_KEY && params.knownProjects.length > 0) {
    // Resolved context text — sender's last matched message, or chat's last matched message.
    const contextMessageText =
      senderContext?.rawMessageText ??
      (chatContext?.projectName !== null ? chatContext?.rawMessageText : null) ??
      null;

    // Recent unresolved chat messages (oldest first) — the primary signal for AI.
    // These accumulate across multiple calls to setChatHint so an earlier
    // "Office Orange County" is not lost when a later "hey" message arrives.
    const recentChatMessages: string[] =
      chatContext?.projectName === null
        ? chatContext.rawMessages.length > 0
          ? [...chatContext.rawMessages]
          : chatContext.rawMessageText
            ? [chatContext.rawMessageText]
            : []
        : [];

    // Include the sender's last message if it adds context not already in the list.
    if (
      senderContext?.rawMessageText &&
      !recentChatMessages.includes(senderContext.rawMessageText)
    ) {
      recentChatMessages.push(senderContext.rawMessageText);
    }

    logger.info(
      {
        senderId: params.senderId,
        chatId: params.chatId,
        hasPreview: previewImagePath !== null,
        hasMessageText: params.messageText !== null,
        hasContextText: contextMessageText !== null,
        recentChatMessageCount: recentChatMessages.length,
        recentChatPreview: recentChatMessages.at(-1)?.slice(0, 80),
        contextSource:
          senderContext !== null
            ? "sender"
            : chatContext?.projectName !== null
              ? "chat-resolved"
              : chatContext !== null
                ? "chat-hint"
                : "none",
        knownProjectCount: params.knownProjects.length,
      },
      "Running AI project inference",
    );

    try {
      const ai = await inferProjectViaAI({
        messageText: params.messageText,
        contextMessageText,
        recentChatMessages,
        originalFilename: params.originalFilename,
        knownProjects: params.knownProjects,
        previewImagePath,
      });

      if (ai.projectName !== null) {
        const confident = ai.confidence >= AI_CONFIDENCE_THRESHOLD;

        logger.info(
          {
            projectName: ai.projectName,
            confidence: ai.confidence,
            confident,
            reasoning: ai.reasoning,
            source: "ai",
          },
          "AI project inference result",
        );

        return {
          projectName: confident ? ai.projectName : MANUAL_REVIEW_PROJECT,
          source: "ai",
          confidence: ai.confidence,
          needsManualReview: !confident,
          reasoning: ai.reasoning,
          ...(ai.suggestedLocation !== undefined
            ? { suggestedLocation: ai.suggestedLocation }
            : {}),
          ...(ai.suggestedDescription !== undefined
            ? { suggestedDescription: ai.suggestedDescription }
            : {}),
          ...(ai.suggestedPhase != null
            ? { suggestedPhase: ai.suggestedPhase }
            : {}),
        };
      }

      logger.info(
        { reasoning: ai.reasoning, source: "ai" },
        "AI could not determine project — routing to Manual Review",
      );
    } catch (error: unknown) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "AI project inference failed — falling back to Manual Review",
      );
    }
  }

  // 5. Unresolved → Manual Review.
  return {
    projectName: MANUAL_REVIEW_PROJECT,
    source: "fallback",
    confidence: 0,
    needsManualReview: true,
    reasoning: "Could not resolve project from context, tag, or AI inference",
  };
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../config/env.js";
import { PROJECT_PHASES } from "../utils/projectFolders.js";
import type { SupportedFileCategory } from "../utils/fileType.js";
import { logger } from "../utils/logger.js";
import { optimizeImageForAI, cleanupAiPreview } from "./aiMediaPreview.js";

const folderHintSchema = z.enum(["Photos", "Renders", "Final"]);
const phaseSchema = z.enum(PROJECT_PHASES);

const classificationSchema = z.object({
  phase: phaseSchema,
  folderHint: folderHintSchema,
  description: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type ClassificationResult = z.infer<typeof classificationSchema>;

let client: OpenAI | null = null;

type UserContentItem =
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
      detail: "auto" | "low" | "high";
    };

function getClient(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }

  return client;
}

function buildFallbackDescription(category: SupportedFileCategory): string {
  if (category === "video") {
    return "SiteWalkVideo";
  }

  if (category === "pdf") {
    return "Document";
  }

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

function buildFallbackClassification(params: {
  category: SupportedFileCategory;
  messageText?: string | null | undefined;
  originalFilename?: string | null | undefined;
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
  };
}

export async function classifyAttachment(params: {
  filePath: string;
  category: SupportedFileCategory;
  messageText?: string | null;
  originalFilename?: string | null;
  projectName?: string | null;
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

  let aiImagePath: string | null = null;

  try {
    if (!env.OPENAI_API_KEY) {
      return fallback;
    }

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
          `Message text: ${params.messageText ?? "None"}`,
      },
    ];

    if (params.category === "image") {
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
          content: [
            {
              type: "input_text",
              text:
                "You classify construction attachments for a file archiver. " +
                "Return valid JSON only. No markdown. No explanations.",
            },
          ],
        },
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    const rawText = response.output_text;

    logger.info(
      {
        filePath: params.filePath,
        rawText,
      },
      "Raw AI response text",
    );

    const parsed = JSON.parse(rawText) as unknown;

    logger.info(
      {
        filePath: params.filePath,
        parsed,
      },
      "Parsed AI response object",
    );

    const result = classificationSchema.parse(parsed);

    logger.info(
      { filePath: params.filePath, result },
      "AI classification completed",
    );

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
    await cleanupAiPreview(aiImagePath);
  }
}

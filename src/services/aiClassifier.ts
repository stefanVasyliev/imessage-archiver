import * as fs from "node:fs/promises";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const classificationSchema = z.object({
  projectName: z.string().min(1),
  phase: z.string().min(1),
  contentType: z.string().min(1),
  description: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export type ClassificationResult = z.infer<typeof classificationSchema>;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: env.OPENAI_API_KEY
    });
  }

  return client;
}

function detectMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";

  return "image/jpeg";
}

export async function classifyImage(filePath: string): Promise<ClassificationResult | null> {
  try {
    const openai = getClient();
    const fileBuffer = await fs.readFile(filePath);
    const base64Image = fileBuffer.toString("base64");
    const mimeType = detectMimeType(filePath);

    const response = await openai.responses.create({
      model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
      input: [
        {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You classify construction-related images. " +
                "Return strict JSON only with keys: " +
                "projectName, phase, contentType, description, confidence. " +
                "projectName should be concise. phase should be a simple category like demo, framing, electrical, finish, roof, plumbing, inspection, materials, furnishing, or unknown. " +
                "contentType should be simple like progress-photo, damage, inspection, materials, document-photo, tool, installation, or unknown. " +
                "description should be short and file-name friendly."
            }
          ]
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Analyze this construction-related file. " +
                "If uncertain, still return your best guess. " +
                "Return valid JSON only."
            },
            {
              type: "input_image",
              image_url: `data:${mimeType};base64,${base64Image}`,
              detail: "auto"
            }
          ]
        }
      ]
    });

    const rawText = response.output_text;
    const parsed = JSON.parse(rawText) as unknown;
    const result = classificationSchema.parse(parsed);

    logger.info({ filePath, result }, "AI classification completed");

    return result;
  } catch (error: unknown) {
    logger.error({ error, filePath }, "AI classification failed");
    return null;
  }
}
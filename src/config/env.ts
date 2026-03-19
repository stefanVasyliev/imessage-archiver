import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  RESEND_API_KEY: z.string().min(1),
  TARGET_CHAT_ID: z.coerce.number().int().positive(),
  MESSAGES_DB_PATH: z.string().min(1),
  APP_STORAGE_ROOT: z.string().min(1),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  REPORT_EMAIL_TO: z.string().optional(),
  REPORT_EMAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3000),
});

export const env = envSchema.parse(process.env);

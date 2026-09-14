import { z } from "zod";

import { OPENCODE_FREE_MODEL, OPENCODE_ZEN_BASE_URL } from "./llm/opencode.js";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Public base URL (Render sets RENDER_EXTERNAL_URL automatically). */
  WEBHOOK_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  /** Path secret so random POSTs cannot inject updates. */
  WEBHOOK_SECRET: z
    .string()
    .min(16)
    .default("change-me-in-production-please"),
  /** Use long polling locally when no public URL is available. */
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  /** OpenCode Zen API key from https://opencode.ai/auth */
  OPENCODE_API_KEY: z.string().min(1).optional(),
  OPENCODE_BASE_URL: z.string().url().default(OPENCODE_ZEN_BASE_URL),
  OPENCODE_MODEL: z.string().min(1).default(OPENCODE_FREE_MODEL),
});

export type Env = z.infer<typeof envSchema> & {
  publicBaseUrl: string | undefined;
};

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse(raw);
  const publicBaseUrl = parsed.WEBHOOK_URL ?? parsed.RENDER_EXTERNAL_URL;

  return {
    ...parsed,
    publicBaseUrl,
  };
}

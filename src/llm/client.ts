import OpenAI from "openai";

import {
  isRateLimitError,
  normalizeDashes,
  sleep,
  type ChatMessage,
  type LlmClient,
} from "./types.js";

/** Anonymous OpenAI-compatible endpoint - no API key required. */
const POLLINATIONS_BASE = "https://text.pollinations.ai/openai";

/**
 * Anonymous-tier aliases for the same GPT-OSS 20B backend.
 * Retries across aliases help when one route is briefly rate-limited.
 */
const MODEL_IDS = ["openai-fast", "openai", "gpt-oss"] as const;

export type LlmProviderConfig = {
  /** Override Pollinations base URL (tests / self-host). */
  baseURL?: string;
  /** Override model id list. */
  models?: readonly string[];
};

/**
 * Keyless LLM via Pollinations anonymous tier (OpenAI chat completions shape).
 */
export function createLlmClient(config: LlmProviderConfig = {}): LlmClient {
  const baseURL = config.baseURL ?? POLLINATIONS_BASE;
  const models = config.models ?? MODEL_IDS;

  const client = new OpenAI({
    apiKey: "anonymous",
    baseURL,
  });

  let lastModel = models[0] ?? "openai-fast";

  async function completeWith(model: string, messages: ChatMessage[]): Promise<string> {
    const chat = await client.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const content = chat.choices[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new Error(`${model} returned empty completion`);
    }
    return normalizeDashes(text);
  }

  return {
    get model() {
      return lastModel;
    },
    async complete(messages: ChatMessage[]): Promise<string> {
      const errors: string[] = [];

      for (const model of models) {
        try {
          const text = await completeWith(model, messages);
          lastModel = model;
          if (model !== models[0]) {
            console.warn(`LLM fallback succeeded with ${model}`);
          }
          return text;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : String(error);
          errors.push(`${model}: ${detail}`);
          console.warn(`LLM failed (${model}):`, detail);
          if (isRateLimitError(error)) {
            await sleep(400);
          }
        }
      }

      throw new Error(
        `All Pollinations models failed. Tried: ${models.join(", ")}. ${errors.join(" | ")}`,
      );
    },
  };
}

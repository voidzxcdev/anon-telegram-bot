import OpenAI from "openai";

import {
  isRateLimitError,
  normalizeDashes,
  sleep,
  type ChatMessage,
  type LlmClient,
} from "./types.js";

export type LlmProviderConfig = {
  geminiApiKey?: string;
  groqApiKey?: string;
};

type ModelTarget = {
  id: string;
  label: string;
  client: OpenAI;
};

/**
 * Better free/fast models outside OpenCode:
 * Gemini 2.5/2.0 Flash (Google AI Studio) + Llama on Groq.
 */
export function createLlmClient(config: LlmProviderConfig): LlmClient | undefined {
  const targets: ModelTarget[] = [];

  if (config.geminiApiKey) {
    const gemini = new OpenAI({
      apiKey: config.geminiApiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
    targets.push(
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash", client: gemini },
      { id: "gemini-2.0-flash", label: "gemini-2.0-flash", client: gemini },
    );
  }

  if (config.groqApiKey) {
    const groq = new OpenAI({
      apiKey: config.groqApiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
    targets.push(
      {
        id: "llama-3.3-70b-versatile",
        label: "groq/llama-3.3-70b",
        client: groq,
      },
      {
        id: "llama-3.1-8b-instant",
        label: "groq/llama-3.1-8b",
        client: groq,
      },
    );
  }

  if (targets.length === 0) {
    return undefined;
  }

  let lastModel = targets[0]!.label;

  async function completeWith(target: ModelTarget, messages: ChatMessage[]): Promise<string> {
    const chat = await target.client.chat.completions.create({
      model: target.id,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const content = chat.choices[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new Error(`${target.label} returned empty completion`);
    }
    return normalizeDashes(text);
  }

  return {
    get model() {
      return lastModel;
    },
    async complete(messages: ChatMessage[]): Promise<string> {
      const errors: string[] = [];

      for (const target of targets) {
        try {
          const text = await completeWith(target, messages);
          lastModel = target.label;
          if (target !== targets[0]) {
            console.warn(`LLM fallback succeeded with ${target.label}`);
          }
          return text;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : String(error);
          errors.push(`${target.label}: ${detail}`);
          console.warn(`LLM failed (${target.label}):`, detail);
          if (isRateLimitError(error)) {
            await sleep(300);
          }
        }
      }

      throw new Error(
        `All LLM providers failed. Tried: ${targets.map((t) => t.label).join(", ")}.`,
      );
    },
  };
}

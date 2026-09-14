import OpenAI from "openai";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/** Primary + fallbacks (OpenCode Zen). */
export const OPENCODE_MODEL_CHAIN = [
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  /** Strong free stealth model on Zen (chat completions). */
  "big-pickle",
] as const;

export type OpenCodeModelId = (typeof OPENCODE_MODEL_CHAIN)[number] | string;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenCodeClient = {
  /** Last model that succeeded (or primary if none yet). */
  model: string;
  complete: (messages: ChatMessage[]) => Promise<string>;
};

type ApiKind = "responses" | "chat";

function apiKindForModel(model: string): ApiKind {
  // Muse Spark free/contributor on Zen use the Responses API.
  if (model.startsWith("muse-spark-")) {
    return "responses";
  }
  return "chat";
}

/** Replace em/en dashes with ASCII hyphen. */
export function normalizeDashes(text: string): string {
  return text.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, "-");
}

export const DASH_RULE =
  'Never use em-dashes or en-dashes. Always use a plain hyphen "-" instead.';

function buildModelChain(preferred?: string): string[] {
  const chain = [...OPENCODE_MODEL_CHAIN];
  if (preferred && !chain.includes(preferred as (typeof OPENCODE_MODEL_CHAIN)[number])) {
    return [preferred, ...chain];
  }
  if (preferred) {
    return [preferred, ...chain.filter((m) => m !== preferred)];
  }
  return chain;
}

/**
 * OpenCode Zen client with automatic model fallback:
 * Muse Spark 1.3 Contributor Free -> Muse Spark 1.2 Contributor Free -> Big Pickle.
 */
export function createOpenCodeClient(
  apiKey: string,
  options: { model?: string; baseURL?: string } = {},
): OpenCodeClient {
  const baseURL = options.baseURL ?? OPENCODE_ZEN_BASE_URL;
  const chain = buildModelChain(options.model);
  const client = new OpenAI({ apiKey, baseURL });

  let lastModel = chain[0] ?? OPENCODE_MODEL_CHAIN[0];

  async function completeWithModel(
    model: string,
    messages: ChatMessage[],
  ): Promise<string> {
    const kind = apiKindForModel(model);

    if (kind === "responses") {
      const response = await client.responses.create({
        model,
        input: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      const text = response.output_text?.trim();
      if (text) {
        return normalizeDashes(text);
      }

      const chunks: string[] = [];
      for (const item of response.output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) {
            chunks.push(part.text);
          }
        }
      }
      const joined = chunks.join("\n").trim();
      if (!joined) {
        throw new Error(`OpenCode ${model} returned an empty responses payload`);
      }
      return normalizeDashes(joined);
    }

    const chat = await client.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const content = chat.choices[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new Error(`OpenCode ${model} returned an empty chat completion`);
    }
    return normalizeDashes(text);
  }

  return {
    get model() {
      return lastModel;
    },
    async complete(messages: ChatMessage[]): Promise<string> {
      const errors: string[] = [];

      for (const model of chain) {
        try {
          const text = await completeWithModel(model, messages);
          lastModel = model;
          if (model !== chain[0]) {
            console.warn(`OpenCode fallback succeeded with ${model}`);
          }
          return text;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : String(error);
          errors.push(`${model}: ${detail}`);
          console.warn(`OpenCode model failed (${model}):`, detail);
        }
      }

      throw new Error(
        `All OpenCode models failed:\n${errors.map((e) => `- ${e}`).join("\n")}`,
      );
    },
  };
}

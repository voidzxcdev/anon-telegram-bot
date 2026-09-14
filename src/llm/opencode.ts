import OpenAI from "openai";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * Primary + fallbacks (OpenCode Zen free models).
 * Muse first, then other free Zen models when Muse is rate-limited.
 */
export const OPENCODE_MODEL_CHAIN = [
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "big-pickle",
  "mimo-v2.5-free",
  "nemotron-3.5-lightning-free",
  "ling-3.0-flash-fin-free",
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
  if (model.startsWith("muse-spark-")) {
    return "responses";
  }
  return "chat";
}

function isMuseModel(model: string): boolean {
  return model.startsWith("muse-spark-");
}

function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: number }).status;
    if (status === 429) return true;
    const code = (error as { code?: string }).code;
    if (code === "rate_limit_exceeded") return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit|too many requests/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * OpenCode Zen client with automatic model fallback + 429 skip.
 * Muse 1.3 -> Muse 1.2 -> Big Pickle -> MiMo -> Nemotron -> Ling
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
      let skipRemainingMuse = false;

      for (const model of chain) {
        if (skipRemainingMuse && isMuseModel(model)) {
          errors.push(`${model}: skipped (Muse rate-limited)`);
          continue;
        }

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

          if (isRateLimitError(error) && isMuseModel(model)) {
            // Muse free tier is hot - jump to other free Zen models.
            skipRemainingMuse = true;
            await sleep(400);
          } else if (isRateLimitError(error)) {
            // Brief pause before next free model
            await sleep(600);
          }
        }
      }

      throw new Error(
        `All OpenCode models failed (rate limits or errors). Tried: ${errors
          .map((e) => e.split(":")[0])
          .join(", ")}. Wait ~1 min and retry Гоша.`,
      );
    },
  };
}

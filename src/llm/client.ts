import {
  isRateLimitError,
  normalizeDashes,
  sleep,
  type ChatMessage,
  type LlmClient,
} from "./types.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "poolside/laguna-s-2.1:free";

export type LlmProviderConfig = {
  /** One or more OpenRouter API keys (rotated on rate limits). */
  apiKeys: string[];
  model?: string;
  /** Optional app attribution for OpenRouter rankings. */
  siteUrl?: string;
  appName?: string;
};

function parseOpenRouterError(raw: string): string {
  try {
    const json = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof json.error === "string") return json.error;
    if (json.error && typeof json.error === "object" && json.error.message) {
      return json.error.message;
    }
    if (json.message) return json.message;
  } catch {
    // ignore
  }
  return raw.slice(0, 220);
}

/**
 * OpenRouter client with multi-key rotation for free-model rate limits.
 */
export function createLlmClient(config: LlmProviderConfig): LlmClient {
  const keys = config.apiKeys.map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error("OPENROUTER_API_KEYS is required (comma-separated)");
  }

  const model = config.model ?? DEFAULT_MODEL;
  let keyIndex = 0;
  let lastModel = `openrouter/${model}`;

  async function completeWithKey(
    apiKey: string,
    keyLabel: string,
    messages: ChatMessage[],
  ): Promise<string> {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "HTTP-Referer": config.siteUrl ?? "https://github.com/voidzxcdev/anon-telegram-bot",
        "X-Title": config.appName ?? "anon-telegram-bot",
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(
        `${keyLabel} HTTP ${res.status}: ${parseOpenRouterError(raw)}`,
      );
      (err as { status?: number }).status = res.status;
      throw err;
    }

    let content = "";
    try {
      const json = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        error?: { message?: string } | string;
      };
      if (json.error) {
        const msg =
          typeof json.error === "string"
            ? json.error
            : (json.error.message ?? JSON.stringify(json.error));
        throw new Error(`${keyLabel}: ${msg}`);
      }
      content = json.choices?.[0]?.message?.content?.trim() ?? "";
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`${keyLabel} invalid JSON: ${raw.slice(0, 160)}`);
      }
      throw error;
    }

    if (!content) {
      throw new Error(`${keyLabel} returned empty completion`);
    }
    return normalizeDashes(content);
  }

  return {
    get model() {
      return lastModel;
    },
    async complete(messages: ChatMessage[]): Promise<string> {
      const errors: string[] = [];
      const start = keyIndex;

      for (let i = 0; i < keys.length; i++) {
        const idx = (start + i) % keys.length;
        const apiKey = keys[idx]!;
        const keyLabel = `openrouter-key${idx + 1}`;

        try {
          const text = await completeWithKey(apiKey, keyLabel, messages);
          keyIndex = (idx + 1) % keys.length;
          lastModel = `openrouter/${model}`;
          if (i > 0) {
            console.warn(`LLM succeeded with ${keyLabel} after failover`);
          }
          return text;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : String(error);
          errors.push(`${keyLabel}: ${detail}`);
          console.warn(`LLM failed (${keyLabel}):`, detail);
          if (isRateLimitError(error)) {
            await sleep(400);
          }
        }
      }

      throw new Error(
        `All OpenRouter keys failed for ${model}. Tried ${keys.length} key(s).`,
      );
    },
  };
}

/** Parse comma/whitespace/newline-separated OpenRouter keys. */
export function parseOpenRouterKeys(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

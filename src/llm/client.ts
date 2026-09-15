import {
  isRateLimitError,
  normalizeDashes,
  sleep,
  type ChatMessage,
  type LlmClient,
} from "./types.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Primary + free fallbacks when Laguna is blocked / rate-limited. */
const DEFAULT_MODELS = [
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "nex-agi/nex-n2.5-mini:free",
  "liquid/lfm-2.5-2.6b:free",
] as const;

/** Skip a key for a while after privacy/config errors (won't magically work next try). */
const BAD_KEY_COOLDOWN_MS = 30 * 60 * 1000;

export type LlmProviderConfig = {
  /** One or more OpenRouter API keys (rotated on rate limits). */
  apiKeys: string[];
  /** Primary model; fallbacks still tried if this fails. */
  model?: string;
  models?: readonly string[];
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

function isPrivacyOrProviderConfigError(message: string): boolean {
  return /guardrail|data policy|training violation|allowed-providers|allowed providers|settings\/privacy/i.test(
    message,
  );
}

/**
 * OpenRouter client: rotate keys + free model fallbacks.
 * Tip: each account must allow free / Poolside at https://openrouter.ai/settings/privacy
 */
export function createLlmClient(config: LlmProviderConfig): LlmClient {
  const keys = config.apiKeys.map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error("OPENROUTER_API_KEYS is required (comma-separated)");
  }

  const models = [
    ...(config.model ? [config.model] : []),
    ...(config.models ?? DEFAULT_MODELS),
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  let keyIndex = 0;
  let lastModel = `openrouter/${models[0]}`;
  /** key index -> cooldown until */
  const badUntil = new Map<number, number>();

  async function completeOnce(
    apiKey: string,
    keyLabel: string,
    model: string,
    messages: ChatMessage[],
  ): Promise<string> {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "HTTP-Referer":
          config.siteUrl ?? "https://github.com/voidzxcdev/anon-telegram-bot",
        "X-Title": config.appName ?? "anon-telegram-bot",
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        // Prefer free endpoints that may train; still overridden by strict account privacy.
        provider: {
          data_collection: "allow",
          allow_fallbacks: true,
        },
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(
        `${keyLabel}/${model} HTTP ${res.status}: ${parseOpenRouterError(raw)}`,
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
        throw new Error(`${keyLabel}/${model}: ${msg}`);
      }
      content = json.choices?.[0]?.message?.content?.trim() ?? "";
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`${keyLabel} invalid JSON: ${raw.slice(0, 160)}`);
      }
      throw error;
    }

    if (!content) {
      throw new Error(`${keyLabel}/${model} returned empty completion`);
    }
    return normalizeDashes(content);
  }

  return {
    get model() {
      return lastModel;
    },
    async complete(messages: ChatMessage[]): Promise<string> {
      const now = Date.now();
      const order: number[] = [];
      for (let i = 0; i < keys.length; i++) {
        const idx = (keyIndex + i) % keys.length;
        const until = badUntil.get(idx) ?? 0;
        if (until > now) continue;
        order.push(idx);
      }
      // If every key is in privacy cooldown, try them anyway (settings may have changed).
      if (order.length === 0) {
        for (let i = 0; i < keys.length; i++) {
          order.push((keyIndex + i) % keys.length);
        }
      }

      for (const model of models) {
        for (const idx of order) {
          const apiKey = keys[idx]!;
          const keyLabel = `key${idx + 1}`;
          try {
            const text = await completeOnce(apiKey, keyLabel, model, messages);
            keyIndex = (idx + 1) % keys.length;
            badUntil.delete(idx);
            lastModel = `openrouter/${model}`;
            return text;
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            console.warn(`LLM failed (${keyLabel}/${model}):`, detail);
            if (isPrivacyOrProviderConfigError(detail)) {
              badUntil.set(idx, Date.now() + BAD_KEY_COOLDOWN_MS);
              console.warn(
                `${keyLabel}: privacy/provider block - fix at https://openrouter.ai/settings/privacy (cooldown 30m)`,
              );
              break; // same key won't work for other free models either if providers locked
            }
            if (isRateLimitError(error)) {
              await sleep(300);
            }
          }
        }
      }

      throw new Error("All OpenRouter keys/models failed");
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

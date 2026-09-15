import {
  isRateLimitError,
  normalizeDashes,
  sleep,
  type ChatMessage,
  type LlmClient,
} from "./types.js";

type ChatTarget = {
  label: string;
  url: string;
  model: string;
  apiKey: string;
  /** Extra JSON body fields (OpenRouter provider prefs, etc.). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const OPENROUTER_FREE_MODELS = [
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "nex-agi/nex-n2.5-mini:free",
  "liquid/lfm-2.5-2.6b:free",
] as const;

/** Groq free-tier GPT-OSS (fast). */
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;

/** Gemini free AI Studio models. */
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"] as const;

const BAD_TARGET_COOLDOWN_MS = 30 * 60 * 1000;

export type LlmProviderConfig = {
  openRouterKeys?: string[];
  openRouterModel?: string;
  groqApiKey?: string;
  geminiApiKey?: string;
  siteUrl?: string;
  appName?: string;
};

function parseApiError(raw: string): string {
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

function isConfigBlockError(message: string): boolean {
  return /guardrail|data policy|training violation|allowed-providers|allowed providers|settings\/privacy|API_KEY_INVALID|invalid.?api.?key|incorrect api key/i.test(
    message,
  );
}

function buildTargets(config: LlmProviderConfig): ChatTarget[] {
  const targets: ChatTarget[] = [];
  const site =
    config.siteUrl ?? "https://github.com/voidzxcdev/anon-telegram-bot";
  const app = config.appName ?? "anon-telegram-bot";

  // Order: OpenRouter → Groq GPT-OSS → Gemini Flash
  const orKeys = (config.openRouterKeys ?? []).map((k) => k.trim()).filter(Boolean);
  const orModels = [
    ...(config.openRouterModel ? [config.openRouterModel] : []),
    ...OPENROUTER_FREE_MODELS,
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  for (let ki = 0; ki < orKeys.length; ki++) {
    const apiKey = orKeys[ki]!;
    for (const model of orModels) {
      targets.push({
        label: `openrouter-key${ki + 1}/${model}`,
        url: OPENROUTER_URL,
        model,
        apiKey,
        headers: {
          "HTTP-Referer": site,
          "X-Title": app,
        },
        extraBody: {
          provider: {
            data_collection: "allow",
            allow_fallbacks: true,
          },
        },
      });
    }
  }

  if (config.groqApiKey) {
    for (const model of GROQ_MODELS) {
      targets.push({
        label: `groq/${model}`,
        url: GROQ_URL,
        model,
        apiKey: config.groqApiKey,
      });
    }
  }

  if (config.geminiApiKey) {
    for (const model of GEMINI_MODELS) {
      targets.push({
        label: `gemini/${model}`,
        url: GEMINI_URL,
        model,
        apiKey: config.geminiApiKey,
      });
    }
  }

  return targets;
}

async function completeOnce(
  target: ChatTarget,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(target.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...target.headers,
    },
    body: JSON.stringify({
      model: target.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: 80,
      ...target.extraBody,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(
      `${target.label} HTTP ${res.status}: ${parseApiError(raw)}`,
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
      throw new Error(`${target.label}: ${msg}`);
    }
    content = json.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${target.label} invalid JSON: ${raw.slice(0, 160)}`);
    }
    throw error;
  }

  if (!content) {
    throw new Error(`${target.label} returned empty completion`);
  }
  return normalizeDashes(content);
}

/**
 * Multi-provider free LLM: OpenRouter → Groq GPT-OSS → Gemini Flash.
 */
export function createLlmClient(config: LlmProviderConfig): LlmClient {
  const targets = buildTargets(config);
  if (targets.length === 0) {
    throw new Error(
      "Configure at least one of GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEYS",
    );
  }

  let cursor = 0;
  let lastModel = targets[0]!.label;
  const badUntil = new Map<string, number>();

  return {
    get model() {
      return lastModel;
    },
    async complete(messages: ChatMessage[]): Promise<string> {
      const now = Date.now();
      const errors: string[] = [];

      for (let i = 0; i < targets.length; i++) {
        const idx = (cursor + i) % targets.length;
        const target = targets[idx]!;
        if ((badUntil.get(target.label) ?? 0) > now) continue;

        try {
          const text = await completeOnce(target, messages);
          cursor = (idx + 1) % targets.length;
          badUntil.delete(target.label);
          lastModel = target.label;
          if (i > 0) {
            console.warn(`LLM fallback succeeded with ${target.label}`);
          }
          return text;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : String(error);
          errors.push(detail);
          console.warn(`LLM failed (${target.label}):`, detail);
          if (isConfigBlockError(detail)) {
            badUntil.set(target.label, Date.now() + BAD_TARGET_COOLDOWN_MS);
            // OpenRouter privacy blocks usually apply to the whole key.
            const orKey = /^openrouter-(key\d+)\//.exec(target.label);
            if (orKey) {
              const prefix = `openrouter-${orKey[1]}/`;
              for (const t of targets) {
                if (t.label.startsWith(prefix)) {
                  badUntil.set(t.label, Date.now() + BAD_TARGET_COOLDOWN_MS);
                }
              }
            }
          }
          if (isRateLimitError(error)) {
            await sleep(300);
          }
        }
      }

      throw new Error(
        `All LLM providers failed (${targets.length} targets).`,
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

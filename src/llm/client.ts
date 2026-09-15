import {
  isRateLimitError,
  normalizeDashes,
  sleep,
  type ChatMessage,
  type LlmClient,
} from "./types.js";

type ProviderTarget = {
  label: string;
  url: string;
  model: string;
  /** Extra headers (never send a real API key). */
  headers?: Record<string, string>;
};

/**
 * Keyless OpenAI-compatible providers (no signup / no API keys).
 * Order: prefer stable anonymous gateways; Pollinations last because its
 * OpenAI SDK path was routing agent UAs onto a budgeted shared key.
 */
const DEFAULT_TARGETS: ProviderTarget[] = [
  {
    label: "llm7/mistral-nemo",
    url: "https://api.llm7.io/v1/chat/completions",
    model: "mistral-Nemo-Instruct-2407",
  },
  {
    label: "kilo/auto-free",
    url: "https://api.kilo.ai/api/gateway/chat/completions",
    model: "kilo-auto/free",
  },
  {
    label: "pollinations/openai-fast",
    url: "https://text.pollinations.ai/openai",
    model: "openai-fast",
    headers: {
      Referer: "https://pollinations.ai/",
      Origin: "https://pollinations.ai",
    },
  },
  {
    label: "ovh/mistral-7b",
    url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
    model: "Mistral-7B-Instruct-v0.3",
  },
];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type LlmProviderConfig = {
  targets?: ProviderTarget[];
};

function looksLikeProviderError(text: string): boolean {
  return /API key used for this request|reached its budget|raise the key budget|enter\.pollinations|insufficient pollen|PAYMENT_REQUIRED|Get unlimited access at/i.test(
    text,
  );
}

async function completeWith(
  target: ProviderTarget,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(target.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": BROWSER_UA,
      ...target.headers,
    },
    body: JSON.stringify({
      model: target.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`${target.label} HTTP ${res.status}: ${raw.slice(0, 180)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }

  let content = "";
  try {
    const json = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: { message?: string } | string;
      message?: string;
    };
    if (json.error) {
      const msg =
        typeof json.error === "string"
          ? json.error
          : (json.error.message ?? JSON.stringify(json.error));
      throw new Error(`${target.label}: ${msg}`);
    }
    if (json.message && !json.choices) {
      throw new Error(`${target.label}: ${json.message}`);
    }
    content = json.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    if (error instanceof SyntaxError) {
      content = raw.trim();
    } else {
      throw error;
    }
  }

  if (!content) {
    throw new Error(`${target.label} returned empty completion`);
  }
  if (looksLikeProviderError(content)) {
    throw new Error(`${target.label} provider error in body: ${content.slice(0, 160)}`);
  }
  return normalizeDashes(content);
}

/**
 * Keyless LLM client with multi-provider failover (no API keys).
 */
export function createLlmClient(config: LlmProviderConfig = {}): LlmClient {
  const targets = config.targets ?? DEFAULT_TARGETS;
  let lastModel = targets[0]?.label ?? "none";

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
            await sleep(800);
          }
        }
      }

      throw new Error(
        `All keyless LLM providers failed. Tried: ${targets.map((t) => t.label).join(", ")}.`,
      );
    },
  };
}

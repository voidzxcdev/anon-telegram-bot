import type { LlmClient } from "../llm/types.js";

/** Detect "draw / generate an image" requests (RU + EN). */
const IMAGE_REQUEST_RE =
  /(?:нарисуй(?:те)?|сгенерируй(?:те)?|сгенерир\w*|сделай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок|фото|pic)|создай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок)|generate(?:\s+me)?(?:\s+an?)?\s+image|draw(?:\s+me)?|create(?:\s+me)?(?:\s+an?)?\s+image|make(?:\s+me)?(?:\s+an?)?\s+(?:image|picture)|picture\s+of|art\s+of|image\s+of)/iu;

const CF_FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export type CloudflareImageConfig = {
  accountId: string;
  apiToken: string;
};

let cloudflareConfig: CloudflareImageConfig | undefined;

export function setCloudflareImageConfig(
  config: CloudflareImageConfig | undefined,
): void {
  cloudflareConfig = config;
}

export function wantsImageGeneration(text: string | undefined): boolean {
  return Boolean(text && IMAGE_REQUEST_RE.test(text));
}

function cleanPrompt(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^prompt\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Translate / improve user request into one English FLUX prompt.
 */
export async function refineImagePrompt(
  llm: LlmClient,
  userText: string,
): Promise<string> {
  const out = await llm.complete(
    [
      {
        role: "system",
        content:
          "You write image prompts for FLUX.1-schnell (Cloudflare Workers AI).\n" +
          "Output ONLY one English prompt. No quotes, no markdown, no explanations.\n" +
          "If the user wrote Russian or another language, translate to clear natural English.\n" +
          "Keep the user's subject and vibe. Add light quality cues (lighting, composition) only if helpful.\n" +
          "Do NOT invent random trash details, watermarks, logos, or unrelated objects.\n" +
          "Max about 40 words. Use ASCII hyphen - only, never em-dashes.",
      },
      {
        role: "user",
        content: `User image request:\n${userText}`,
      },
    ],
    { maxTokens: 120 },
  );

  const prompt = cleanPrompt(out);
  if (!prompt) {
    throw new Error("empty image prompt from LLM");
  }
  return prompt.slice(0, 800);
}

export type GeneratedImage = {
  bytes: Buffer;
  prompt: string;
};

/**
 * Cloudflare Workers AI — FLUX.1-schnell (free Neurons daily).
 */
export async function generateCloudflareFluxImage(
  prompt: string,
): Promise<GeneratedImage> {
  if (!cloudflareConfig?.accountId || !cloudflareConfig.apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required for images",
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${cloudflareConfig.accountId}/ai/run/${CF_FLUX_MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cloudflareConfig.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      steps: 4,
      seed: Math.floor(Math.random() * 1_000_000_000),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudflare AI HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }

  let imageB64 = "";
  try {
    const json = JSON.parse(raw) as {
      success?: boolean;
      result?: { image?: string } | string;
      errors?: Array<{ message?: string }>;
    };
    if (json.success === false) {
      const msg = json.errors?.[0]?.message ?? raw.slice(0, 160);
      throw new Error(`Cloudflare AI: ${msg}`);
    }
    if (typeof json.result === "string") {
      imageB64 = json.result;
    } else if (json.result?.image) {
      imageB64 = json.result.image;
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Cloudflare AI bad JSON: ${raw.slice(0, 160)}`);
    }
    throw error;
  }

  if (!imageB64) {
    throw new Error("Cloudflare AI returned no image");
  }

  const bytes = Buffer.from(imageB64, "base64");
  if (bytes.length < 1000) {
    throw new Error("Cloudflare AI image too small / empty");
  }

  return { bytes, prompt };
}

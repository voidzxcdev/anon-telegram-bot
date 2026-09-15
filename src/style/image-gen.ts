import type { LlmClient } from "../llm/types.js";

/** Detect "draw / generate an image" requests (RU + EN). */
const IMAGE_REQUEST_RE =
  /(?:нарисуй(?:те)?|сгенерируй(?:те)?|сгенерир\w*|сделай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок|фото|pic)|создай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок)|generate(?:\s+me)?(?:\s+an?)?\s+image|draw(?:\s+me)?|create(?:\s+me)?(?:\s+an?)?\s+image|make(?:\s+me)?(?:\s+an?)?\s+(?:image|picture)|picture\s+of|art\s+of|image\s+of)/iu;

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
 * Translate / lightly improve user request into one English Pollinations prompt.
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
          "You write image prompts for Pollinations AI.\n" +
          "Output ONLY one English prompt. No quotes, no markdown, no explanations.\n" +
          "If the user wrote Russian or another language, translate to clear English.\n" +
          "Lightly improve for composition, lighting, and detail - keep their intent.\n" +
          "Max about 60 words. Use ASCII hyphen - only, never em-dashes.",
      },
      {
        role: "user",
        content: `User image request:\n${userText}`,
      },
    ],
    { maxTokens: 180 },
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
  url: string;
};

/**
 * Keyless Pollinations image generation (Flux).
 */
export async function generatePollinationsImage(
  prompt: string,
): Promise<GeneratedImage> {
  const params = new URLSearchParams({
    width: "1024",
    height: "1024",
    nologo: "true",
    model: "flux",
    // bust CDN cache for repeated prompts
    seed: String(Math.floor(Math.random() * 1_000_000_000)),
  });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "image/*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`Pollinations image HTTP ${res.status}`);
  }

  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) {
    const body = (await res.text()).slice(0, 120);
    throw new Error(`Pollinations did not return an image: ${body}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) {
    throw new Error("Pollinations image too small / empty");
  }

  return { bytes, prompt, url };
}

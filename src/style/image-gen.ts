/** Detect "draw / generate an image" requests (RU + EN). */
const IMAGE_REQUEST_RE =
  /(?:нарисуй(?:те)?|сгенерируй(?:те)?|сгенерир\w*|сделай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок|фото|pic)|создай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок)|generate(?:\s+me)?(?:\s+an?)?\s+image|draw(?:\s+me)?|create(?:\s+me)?(?:\s+an?)?\s+image|make(?:\s+me)?(?:\s+an?)?\s+(?:image|picture)|picture\s+of|art\s+of|image\s+of)/iu;

/** Strip Гоша / gosha callouts so they never become image subjects. */
const GOSHA_STRIP_RE =
  /(?<!\p{L})(?:гошанчик(?:а|у|е|ом|ов|ами|ах)?|гошик(?:а|у|е|ом|ов|ами|ах)?|гош(?:а|и|е|у|ей|ею|ью|ка|ки|ке|ку|кой|кою)?|gosha)(?!\p{L})/giu;

/** Cloudflare Workers AI image model. */
const CF_FLUX_MODEL = "@cf/black-forest-labs/flux-2-dev";

export type CloudflareImageConfig = {
  accountId: string;
  apiToken: string;
  /** Optional Workers proxy URL (Bearer = CLOUDFLARE_API_TOKEN). */
  gatewayUrl?: string;
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

/**
 * No LLM enhance — strip trigger words and use the user's subject as-is.
 * "гошанчик сгенерируй арбуз" → "арбуз"
 */
export function extractImagePrompt(userText: string): string {
  let prompt = userText
    .replace(GOSHA_STRIP_RE, " ")
    .replace(IMAGE_REQUEST_RE, " ")
    .replace(
      /(?:пожалуйста|плиз|pls|please|мне|для\s+меня|картинк\w*|изображен\w*|рисунок|фото|арт|pic|image|picture|photo)/giu,
      " ",
    )
    .replace(/[^\p{L}\p{N}\s.,!?+\-_/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!prompt) {
    throw new Error("empty image prompt after stripping triggers");
  }
  return prompt.slice(0, 800);
}

/** @deprecated use extractImagePrompt — kept name for callers during transition */
export async function refineImagePrompt(
  _llm: unknown,
  userText: string,
): Promise<string> {
  return extractImagePrompt(userText);
}

export type GeneratedImage = {
  bytes: Buffer;
  prompt: string;
};

/**
 * Cloudflare Workers AI — FLUX.2 [dev] (multipart form required).
 */
export async function generateCloudflareFluxImage(
  prompt: string,
): Promise<GeneratedImage> {
  if (!cloudflareConfig?.accountId || !cloudflareConfig.apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required for images",
    );
  }

  const url =
    cloudflareConfig.gatewayUrl?.replace(/\/$/, "") ||
    `https://api.cloudflare.com/client/v4/accounts/${cloudflareConfig.accountId}/ai/run/${CF_FLUX_MODEL}`;

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "1024");
  form.append("steps", "20");
  form.append("seed", String(Math.floor(Math.random() * 1_000_000_000)));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cloudflareConfig.apiToken}`,
    },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudflare AI HTTP ${res.status}: ${raw.slice(0, 220)}`);
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

/** Detect "draw / generate an image" requests (RU + EN). */
const IMAGE_REQUEST_RE =
  /(?:нарисуй(?:те)?|сгенерируй(?:те)?|сгенерир\w*|сделай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок|фото|pic)|создай(?:те)?\s+(?:мне\s+)?(?:картинк\w*|изображен\w*|арт|рисунок)|generate(?:\s+me)?(?:\s+an?)?\s+image|draw(?:\s+me)?|create(?:\s+me)?(?:\s+an?)?\s+image|make(?:\s+me)?(?:\s+an?)?\s+(?:image|picture)|picture\s+of|art\s+of|image\s+of)/iu;

/** Strip Гоша / gosha callouts so they never become image subjects. */
const GOSHA_STRIP_RE =
  /(?<!\p{L})(?:гошанчик(?:а|у|е|ом|ов|ами|ах)?|гошик(?:а|у|е|ом|ов|ами|ах)?|гош(?:а|и|е|у|ей|ею|ью|ка|ки|ке|ку|кой|кою)?|gosha)(?!\p{L})/giu;

/** Free-tier Cloudflare model (when Neurons remain). */
const CF_FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** Gemini native image model (fallback when CF Neurons are empty). */
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

export type ImageGenConfig = {
  accountId?: string;
  apiToken?: string;
  gatewayUrl?: string;
  geminiApiKey?: string;
};

let imageGenConfig: ImageGenConfig | undefined;

export function setCloudflareImageConfig(
  config: ImageGenConfig | undefined,
): void {
  imageGenConfig = config;
}

export function wantsImageGeneration(text: string | undefined): boolean {
  return Boolean(text && IMAGE_REQUEST_RE.test(text));
}

/**
 * No LLM enhance — strip trigger words and use the user's subject as-is.
 */
export function extractImagePrompt(userText: string): string {
  const prompt = userText
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

export class ImageGenError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string, detail: string) {
    super(detail);
    this.name = "ImageGenError";
    this.userMessage = userMessage;
  }
}

function isNeuronExhausted(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes("4006") ||
    lower.includes("neurons") ||
    lower.includes("daily free allocation")
  );
}

/**
 * CF FLUX.1-schnell first; on Neuron exhaustion fall back to Gemini image.
 */
export async function generateCloudflareFluxImage(
  prompt: string,
): Promise<GeneratedImage> {
  const cfg = imageGenConfig;
  const hasCf = Boolean(cfg?.accountId && cfg?.apiToken);
  const hasGemini = Boolean(cfg?.geminiApiKey);

  if (!hasCf && !hasGemini) {
    throw new ImageGenError(
      "Фото выключено — нет ключей",
      "Need CLOUDFLARE_* and/or GEMINI_API_KEY for images",
    );
  }

  let cfError: unknown;
  if (hasCf) {
    try {
      return await generateViaCloudflare(prompt);
    } catch (error) {
      cfError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (!hasGemini || !isNeuronExhausted(detail)) {
        throw error;
      }
      console.warn(
        "Cloudflare Neurons exhausted — falling back to Gemini image",
      );
    }
  }

  if (hasGemini) {
    return generateViaGemini(prompt);
  }

  throw cfError instanceof Error
    ? cfError
    : new ImageGenError("Фото не собралось", String(cfError));
}

async function generateViaCloudflare(prompt: string): Promise<GeneratedImage> {
  const cfg = imageGenConfig!;
  const url =
    cfg.gatewayUrl?.replace(/\/$/, "") ||
    `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${CF_FLUX_MODEL}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(120_000),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw mapCloudflareFailure(res.status, raw);
  }

  const bytes = decodeCloudflareImage(raw);
  return { bytes, prompt };
}

async function generateViaGemini(prompt: string): Promise<GeneratedImage> {
  const key = imageGenConfig!.geminiApiKey!;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new ImageGenError(
      "Gemini фото тоже не вывезло, попробуй позже",
      `Gemini image HTTP ${res.status}: ${raw.slice(0, 220)}`,
    );
  }

  let json: {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new ImageGenError(
      "Gemini фото сломалось",
      `Gemini image bad JSON: ${raw.slice(0, 160)}`,
    );
  }

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const data = parts.map((p) => p.inlineData?.data).find(Boolean);
  if (!data) {
    throw new ImageGenError(
      "Gemini фото пустое",
      `Gemini image no inline data: ${raw.slice(0, 200)}`,
    );
  }

  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 1000) {
    throw new ImageGenError(
      "Gemini фото пустое",
      "Gemini image too small",
    );
  }
  return { bytes, prompt };
}

function decodeCloudflareImage(raw: string): Buffer {
  let imageB64 = "";
  try {
    const json = JSON.parse(raw) as {
      success?: boolean;
      result?: { image?: string } | string;
      errors?: Array<{ message?: string }>;
    };
    if (json.success === false) {
      throw mapCloudflareFailure(200, raw);
    }
    if (typeof json.result === "string") {
      imageB64 = json.result;
    } else if (json.result?.image) {
      imageB64 = json.result.image;
    }
  } catch (error) {
    if (error instanceof ImageGenError) throw error;
    if (error instanceof SyntaxError) {
      throw new ImageGenError(
        "Фото сломалось, попробуй ещё раз",
        `Cloudflare AI bad JSON: ${raw.slice(0, 160)}`,
      );
    }
    throw error;
  }

  if (!imageB64) {
    throw new ImageGenError(
      "Фото пустое пришло, попробуй ещё раз",
      "Cloudflare AI returned no image",
    );
  }

  const bytes = Buffer.from(imageB64, "base64");
  if (bytes.length < 1000) {
    throw new ImageGenError(
      "Фото пустое пришло, попробуй ещё раз",
      "Cloudflare AI image too small / empty",
    );
  }
  return bytes;
}

function mapCloudflareFailure(status: number, raw: string): ImageGenError {
  if (isNeuronExhausted(raw)) {
    return new ImageGenError(
      "Лимит Cloudflare на сегодня кончился, завтра ок",
      `Cloudflare AI HTTP ${status}: ${raw.slice(0, 220)}`,
    );
  }
  if (status === 401 || status === 403) {
    return new ImageGenError(
      "Cloudflare ключ отвалился",
      `Cloudflare AI HTTP ${status}: ${raw.slice(0, 220)}`,
    );
  }
  return new ImageGenError(
    "Фото не собралось, попробуй ещё раз",
    `Cloudflare AI HTTP ${status}: ${raw.slice(0, 220)}`,
  );
}

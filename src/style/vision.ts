/**
 * Free image recognition for Гоша group context.
 * Uses Gemini Flash multimodal (GEMINI_API_KEY / AI Studio free tier).
 * Fail-soft: timeouts and errors return undefined — never block replies.
 */

import type { Api } from "grammy";

const VISION_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash"] as const;
const VISION_TIMEOUT_MS = 8_000;
/** Keep captions short so history prompts stay lean. */
export const MAX_PHOTO_DESC = 120;
/** Prefer a mid-size Telegram photo for speed (bytes / latency). */
const MAX_DOWNLOAD_BYTES = 1_200_000;

/** Dedupe twin-bot / webhook retries: file_id → in-flight or settled description. */
const descInflight = new Map<string, Promise<string | undefined>>();
const DESC_CACHE_MAX = 200;

export type VisionConfig = {
  geminiApiKey?: string;
};

let visionConfig: VisionConfig | undefined;

export function setVisionConfig(config: VisionConfig | undefined): void {
  visionConfig = config;
}

export function visionEnabled(): boolean {
  return Boolean(visionConfig?.geminiApiKey);
}

type PhotoSizeLike = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

/**
 * Pick a mid-size photo: second-largest when available, else largest.
 * Keeps vision calls cheap/fast vs always downloading the full original.
 */
export function pickPhotoForVision(photos: PhotoSizeLike[]): PhotoSizeLike {
  const sorted = [...photos].sort(
    (a, b) => (a.file_size ?? a.width * a.height) - (b.file_size ?? b.width * b.height),
  );
  if (sorted.length >= 2) {
    return sorted[sorted.length - 2]!;
  }
  return sorted[sorted.length - 1]!;
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Download a Telegram photo as base64 + mime. Soft-fail → undefined.
 */
export async function downloadTelegramPhoto(
  api: Api,
  photos: PhotoSizeLike[],
): Promise<{ base64: string; mimeType: string } | undefined> {
  if (photos.length === 0) return undefined;
  try {
    const pick = pickPhotoForVision(photos);
    const file = await api.getFile(pick.file_id);
    if (!file.file_path) return undefined;

    const token = api.token;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`vision download HTTP ${res.status}`);
      return undefined;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return undefined;
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      // Still try — Gemini accepts it; log for ops awareness.
      console.warn(`vision photo large: ${buf.length} bytes`);
    }

    return {
      base64: buf.toString("base64"),
      mimeType: mimeFromPath(file.file_path),
    };
  } catch (error) {
    console.warn(
      "vision download failed",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

function parseGeminiText(raw: string): string | undefined {
  try {
    const json = JSON.parse(raw) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      error?: { message?: string };
    };
    if (json.error?.message) {
      throw new Error(json.error.message);
    }
    const text = json.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join(" ")
      .trim();
    return text || undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Concise one-line description via Gemini Flash. Soft-fail → undefined.
 */
export async function describeImageBytes(
  base64: string,
  mimeType: string,
): Promise<string | undefined> {
  const key = visionConfig?.geminiApiKey;
  if (!key) return undefined;

  const prompt =
    "Describe this photo in one short sentence for group-chat context. " +
    "Name the main subject and setting. No fluff, no markdown, no quotes.";

  for (const model of VISION_MODELS) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
      `?key=${encodeURIComponent(key)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: base64 } },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 48,
            temperature: 0.2,
          },
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });

      const raw = await res.text();
      if (!res.ok) {
        console.warn(`vision ${model} HTTP ${res.status}: ${raw.slice(0, 180)}`);
        continue;
      }

      const text = parseGeminiText(raw);
      if (!text) {
        console.warn(`vision ${model} empty response`);
        continue;
      }

      return text.replace(/\s+/g, " ").trim().slice(0, MAX_PHOTO_DESC);
    } catch (error) {
      console.warn(
        `vision ${model} failed`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return undefined;
}

/**
 * Format a history/LLM line for a photo message.
 * Prefer `[photo: desc]` + optional caption; caption-only if vision fails.
 */
export function formatPhotoContextText(
  caption: string | undefined,
  description: string | undefined,
): string {
  const cap = (caption ?? "").trim();
  const desc = (description ?? "").trim();

  if (desc && cap) {
    return `[photo: ${desc}] ${cap}`.slice(0, 500);
  }
  if (desc) {
    return `[photo: ${desc}]`.slice(0, 500);
  }
  if (cap) {
    return cap.slice(0, 500);
  }
  // Last resort so photo-only still occupies a history slot.
  return "[photo]";
}

/**
 * Download + describe a Telegram photo for context. Soft-fail.
 * Caches by largest file_id so twin bots in one process only hit Gemini once.
 */
export async function describeTelegramPhoto(
  api: Api,
  photos: PhotoSizeLike[],
): Promise<string | undefined> {
  if (!visionEnabled() || photos.length === 0) return undefined;

  const cacheKey = photos[photos.length - 1]!.file_id;
  const existing = descInflight.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    const downloaded = await downloadTelegramPhoto(api, photos);
    if (!downloaded) return undefined;
    return describeImageBytes(downloaded.base64, downloaded.mimeType);
  })();

  descInflight.set(cacheKey, pending);
  while (descInflight.size > DESC_CACHE_MAX) {
    const oldest = descInflight.keys().next().value;
    if (oldest == null) break;
    descInflight.delete(oldest);
  }

  return pending;
}

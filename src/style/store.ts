import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import path from "node:path";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type MediaKind =
  | "text"
  | "photo"
  | "video"
  | "animation"
  | "document"
  | "audio"
  | "voice"
  | "video_note"
  | "sticker"
  | "unknown";

/** One anonymized utterance collected from /m or /с — shared by both learners. */
export type StyleSample = {
  id: string;
  at: string; // ISO
  chatId: number;
  /** Telegram user id of the author (for filtering owner samples later). */
  userId: number;
  command: "m" | "с";
  text: string;
  media: MediaKind;
  isReply: boolean;
  languageHint: "ru" | "en" | "mixed" | "unknown";
};

export type StyleProfile = {
  updatedAt: string;
  sampleCount: number;
  windowDays: 30;
  /** Distilled voice card used by both persona bots. */
  card: string;
  rawNotes?: string;
};

function detectLanguage(text: string): StyleSample["languageHint"] {
  const hasCyr = /[\u0400-\u04FF]/.test(text);
  const hasLat = /[A-Za-z]/.test(text);
  if (hasCyr && hasLat) return "mixed";
  if (hasCyr) return "ru";
  if (hasLat) return "en";
  return "unknown";
}

export function inferMediaKind(message: {
  photo?: unknown;
  video?: unknown;
  animation?: unknown;
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  video_note?: unknown;
  sticker?: unknown;
  text?: string;
}): MediaKind {
  if (message.photo) return "photo";
  if (message.animation) return "animation";
  if (message.video) return "video";
  if (message.document) return "document";
  if (message.audio) return "audio";
  if (message.voice) return "voice";
  if (message.video_note) return "video_note";
  if (message.sticker) return "sticker";
  if (message.text) return "text";
  return "unknown";
}

export class StyleStore {
  readonly dataDir: string;
  readonly samplesPath: string;
  readonly profilePath: string;

  constructor(dataDir = path.join(process.cwd(), "data")) {
    this.dataDir = dataDir;
    this.samplesPath = path.join(dataDir, "style-samples.jsonl");
    this.profilePath = path.join(dataDir, "style-profile.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  async record(sample: Omit<StyleSample, "id" | "at" | "languageHint"> & {
    languageHint?: StyleSample["languageHint"];
  }): Promise<StyleSample> {
    await this.init();
    const full: StyleSample = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      languageHint: sample.languageHint ?? detectLanguage(sample.text),
      chatId: sample.chatId,
      userId: sample.userId,
      command: sample.command,
      text: sample.text,
      media: sample.media,
      isReply: sample.isReply,
    };

    await appendFile(this.samplesPath, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  async listRecent(withinMs = THIRTY_DAYS_MS): Promise<StyleSample[]> {
    await this.init();
    let raw = "";
    try {
      raw = await readFile(this.samplesPath, "utf8");
    } catch {
      return [];
    }

    const cutoff = Date.now() - withinMs;
    const samples: StyleSample[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as StyleSample;
        if (Date.parse(parsed.at) >= cutoff) {
          samples.push(parsed);
        }
      } catch {
        // skip corrupt lines
      }
    }
    return samples;
  }

  /** Drop samples older than 30 days (rewrites file). */
  async prune(): Promise<number> {
    const kept = await this.listRecent();
    const tmp = `${this.samplesPath}.tmp`;
    const body = kept.map((s) => JSON.stringify(s)).join("\n");
    await writeFile(tmp, body ? `${body}\n` : "", "utf8");
    await rename(tmp, this.samplesPath);
    return kept.length;
  }

  async readProfile(): Promise<StyleProfile | undefined> {
    try {
      const raw = await readFile(this.profilePath, "utf8");
      return JSON.parse(raw) as StyleProfile;
    } catch {
      return undefined;
    }
  }

  async writeProfile(profile: StyleProfile): Promise<void> {
    await this.init();
    const tmp = `${this.profilePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await rename(tmp, this.profilePath);
  }
}

/** Singleton shared by both persona bots + capture pipeline. */
let sharedStore: StyleStore | undefined;

export function getSharedStyleStore(dataDir?: string): StyleStore {
  if (!sharedStore || (dataDir && sharedStore.dataDir !== dataDir)) {
    sharedStore = new StyleStore(dataDir);
  }
  return sharedStore;
}

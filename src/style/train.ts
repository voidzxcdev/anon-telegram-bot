import type { LlmClient } from "../llm/types.js";
import {
  getSharedStyleStore,
  type StyleProfile,
  type StyleSample,
  type StyleStore,
} from "./store.js";

const MAX_SAMPLES_FOR_TRAIN = 80;
const MAX_CHARS_PER_SAMPLE = 400;

function formatSamples(samples: StyleSample[]): string {
  const slice = samples.slice(-MAX_SAMPLES_FOR_TRAIN);
  return slice
    .map((s, i) => {
      const text = s.text
        ? s.text.slice(0, MAX_CHARS_PER_SAMPLE)
        : `(${s.media} only, no caption)`;
      return `${i + 1}. [${s.languageHint}/${s.media}${s.isReply ? "/reply" : ""}] ${text}`;
    })
    .join("\n");
}

/**
 * Distill a shared voice card from the last 30 days of /m and /с samples.
 * Both persona bots read this same profile.
 */
export async function distillSharedStyleProfile(
  llm: LlmClient,
  store: StyleStore = getSharedStyleStore(),
): Promise<StyleProfile | undefined> {
  await store.prune();
  const samples = await store.listRecent();
  if (samples.length === 0) {
    return undefined;
  }

  const prompt =
    "You are building a writing-style card for two chatbots that must sound like the same person.\n" +
    "Analyze ONLY tone, slang, emoji habits, sentence length, bilingual RU/EN mix, humor, and reply habits.\n" +
    "Do NOT copy private facts, names, addresses, phone numbers, or secrets into the card.\n" +
    'Never use em-dashes or en-dashes in the card - use plain hyphen "-" only.\n' +
    "Return a compact style card in plain text (bullet rules), max ~400 words.\n\n" +
    `Samples (${samples.length} in 30-day window, showing up to ${MAX_SAMPLES_FOR_TRAIN}):\n` +
    formatSamples(samples);

  const card = await llm.complete([
    {
      role: "system",
      content:
        'Extract speaking style only. Refuse to store or repeat sensitive personal data. Use "-" not em-dashes.',
    },
    { role: "user", content: prompt },
  ]);

  const profile: StyleProfile = {
    updatedAt: new Date().toISOString(),
    sampleCount: samples.length,
    windowDays: 30,
    card: card.trim(),
  };

  await store.writeProfile(profile);
  return profile;
}

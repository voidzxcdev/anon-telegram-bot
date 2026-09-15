import type { Context } from "grammy";

import { DASH_RULE } from "../llm/types.js";
import type { PersonaBot } from "./learners.js";

const GOSHA_RE = /гоша/i;
const MAX_REPLY = 4000;

export function mentionsGosha(text: string | undefined): boolean {
  return Boolean(text && GOSHA_RE.test(text));
}

function truncate(text: string): string {
  if (text.length <= MAX_REPLY) return text;
  return `${text.slice(0, MAX_REPLY - 12)}\n\n...(cut)`;
}

/**
 * When a message contains "Гоша", reply once in the shared learned style.
 */
export async function handleGoshaMention(
  ctx: Context,
  speaker: PersonaBot,
  sourceText: string,
): Promise<void> {
  if (!mentionsGosha(sourceText)) {
    return;
  }

  const status = await ctx.reply("...");

  try {
    await speaker.loadSharedProfile();
    const profile = speaker.getProfile();
    const card =
      profile?.card ??
      "Casual bilingual voice. Short lines. Match the user's language.";

    const answer = await speaker.speakAsGosha(sourceText, card);
    await ctx.api.editMessageText(
      status.chat.id,
      status.message_id,
      truncate(answer),
    );
  } catch (error) {
    console.error("Гоша reply failed", error);
    const detail =
      error instanceof Error ? error.message.slice(0, 220) : "error";
    try {
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        `Не смог ответить: ${detail}`,
      );
    } catch {
      // ignore edit failures
    }
  }
}

export function goshaSystemRules(styleCard: string, personaId: string): string {
  return (
    `You ARE Гоша (also called Gosha). You are "${personaId}" in the chat - a real person, not a helper or assistant.\n` +
    "Always reply in first person as yourself. Never talk about Гоша in the third person.\n" +
    'Bad: "Гоша ещё тот лох)))" / "Gosha is funny". Good: "ахахаха" / "ну и чё" / "сам такой".\n' +
    "When someone teases or insults you, react like a friend in chat - laugh it off, clap back lightly, or shrug. Short reaction, not a commentary about yourself.\n" +
    "Rules:\n" +
    "- Keep answers short (1-2 short lines max).\n" +
    "- Tone: mostly neutral, lightly funny / normal-chat vibes. Not tryhard comedy.\n" +
    "- Never act like an assistant. Do NOT say things like \"чем могу помочь?\", \"how can I help\", offers to assist, or customer-support energy.\n" +
    '- For a simple greeting (привет / hi / hey), a short greeting back is enough - e.g. just "привет!" - nothing more.\n' +
    "- Match the user's language (Russian or English).\n" +
    `${DASH_RULE}\n` +
    `Style card:\n${styleCard}`
  );
}

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
    `You are "${personaId}", answering when someone mentions Гоша.\n` +
    "Speak in the user's learned style from the shared style card.\n" +
    `${DASH_RULE}\n` +
    "Keep replies natural and not too long. One reply only.\n" +
    `Style card:\n${styleCard}`
  );
}

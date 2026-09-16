import type { Api, Bot } from "grammy";

import type { PersonaId, TwinLearners } from "./learners.js";
import {
  CONTEXT_LIMIT,
  formatContextForPrompt,
  getRecentContext,
  listActiveChatIds,
  recordGoshaTurn,
} from "./history.js";
import { isQuietHours } from "./quiet-hours.js";
import { tryAcquireGoshaLock, releaseGoshaLock } from "./gosha-lock.js";

export const CHATTER_INTERVAL_MS = 15 * 60 * 1000;

/** Hard cap for proactive lines (same vibe as mention replies). */
const MAX_CHATTER = 90;

export type ChatterBot = {
  api: Api;
  personaId: PersonaId;
  label: string;
};

function truncate(text: string): string {
  const cleaned = text.trim();
  if (cleaned.length <= MAX_CHATTER) return cleaned;
  return `${cleaned.slice(0, MAX_CHATTER - 1).trimEnd()}…`;
}

/**
 * Pick which twin should speak this tick (alternate by tick count).
 */
export function pickChatterPersona(tick: number): PersonaId {
  return tick % 2 === 0 ? "alpha" : "beta";
}

async function sendProactiveLine(
  bot: ChatterBot,
  twins: TwinLearners,
  chatId: number,
): Promise<void> {
  const speaker = bot.personaId === "alpha" ? twins.alpha : twins.beta;
  const turns = getRecentContext(chatId, CONTEXT_LIMIT);
  if (turns.length === 0) return;

  // Synthetic message id so the shared Гоша lock can serialize with mentions.
  const syntheticMsgId = -Math.abs(Date.now() % 1_000_000_000);
  if (!tryAcquireGoshaLock(chatId, syntheticMsgId)) {
    console.warn(
      `chatter skipped (lock) chat=${chatId} persona=${bot.personaId}`,
    );
    return;
  }

  try {
    const profile = speaker.getProfile();
    const card =
      profile?.card ??
      "Short punchy group-chat replies. Modern / dry. Never coachy.";
    const groupContext = formatContextForPrompt(turns);

    await bot.api.sendChatAction(chatId, "typing");
    const answer = await speaker.speakProactive(card, groupContext);
    const replyText = truncate(answer);
    if (!replyText) return;

    const sent = await bot.api.sendMessage(chatId, replyText);
    recordGoshaTurn(chatId, sent.message_id, replyText);
    console.log(
      `chatter ${bot.label} chat=${chatId}: ${replyText.slice(0, 60)}`,
    );
  } finally {
    releaseGoshaLock(chatId, syntheticMsgId);
  }
}

/**
 * Every ~15 minutes (outside Berlin quiet hours), one of the twin bots
 * drops a short line into each recently active group, using last 50 msgs.
 */
export function startProactiveChatter(
  bots: ChatterBot[],
  twins: TwinLearners,
  intervalMs = CHATTER_INTERVAL_MS,
): () => void {
  if (bots.length === 0) {
    console.warn("proactive chatter: no bots configured");
    return () => {};
  }

  let tick = 0;
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    if (isQuietHours()) {
      console.log("chatter: quiet hours (Europe/Berlin 23:00–07:00), skip");
      return;
    }

    const persona = pickChatterPersona(tick++);
    const bot = bots.find((b) => b.personaId === persona) ?? bots[0];
    if (!bot) return;

    const chats = listActiveChatIds();
    if (chats.length === 0) {
      console.log("chatter: no active chats yet");
      return;
    }

    for (const chatId of chats) {
      if (stopped) return;
      try {
        await sendProactiveLine(bot, twins, chatId);
      } catch (error) {
        console.warn(`chatter failed chat=${chatId}`, error);
      }
    }
  };

  console.log(
    `proactive chatter every ${Math.round(intervalMs / 60_000)}m ` +
      `(quiet 23:00–07:00 Europe/Berlin); bots=${bots.map((b) => b.label).join(",")}`,
  );

  const handle = setInterval(() => {
    void run();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/** Build ChatterBot descriptors from running grammy Bots. */
export function chatterFromBot(
  bot: Bot,
  personaId: PersonaId,
  label: string,
): ChatterBot {
  return { api: bot.api, personaId, label };
}

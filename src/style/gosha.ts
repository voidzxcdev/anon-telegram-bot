import type { Context } from "grammy";

import { DASH_RULE } from "../llm/types.js";
import type { PersonaBot } from "./learners.js";

/**
 * Matches Гоша in common Russian cases + short/diminutive forms + Latin "gosha".
 * Case-insensitive (гоша / ГОША / Гошу / гоше / гош …).
 */
const GOSHA_RE =
  /(?<!\p{L})(?:гош(?:а|и|е|у|ей|ею|ью|ка|ки|ке|ку|кой|кою)?|gosha)(?!\p{L})/iu;

/** Hard cap - models love essays; keep Гоша chat-sized. */
const MAX_REPLY = 160;

const THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const THINKING_TICK_MS = 180;

export function mentionsGosha(text: string | undefined): boolean {
  if (!text) return false;
  GOSHA_RE.lastIndex = 0;
  return GOSHA_RE.test(text);
}

function truncate(text: string): string {
  const cleaned = text.trim();
  if (cleaned.length <= MAX_REPLY) return cleaned;
  return `${cleaned.slice(0, MAX_REPLY - 1).trimEnd()}…`;
}

function startThinkingAnimation(
  edit: (text: string) => Promise<void>,
): () => void {
  let frame = 0;
  let stopped = false;
  let inFlight = false;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    frame = (frame + 1) % THINKING_FRAMES.length;
    const text = THINKING_FRAMES[frame]!;
    inFlight = true;
    void edit(text)
      .catch(() => {
        // ignore flood / unchanged / deleted
      })
      .finally(() => {
        inFlight = false;
      });
  }, THINKING_TICK_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
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

  const status = await ctx.reply(THINKING_FRAMES[0]!);
  const chatId = status.chat.id;
  const messageId = status.message_id;

  const stopThinking = startThinkingAnimation(async (text) => {
    await ctx.api.editMessageText(chatId, messageId, text);
  });

  try {
    await speaker.loadSharedProfile();
    const profile = speaker.getProfile();
    const card =
      profile?.card ??
      "Short punchy group-chat replies. Modern / dry. Never coachy.";

    const from = ctx.from;
    const who =
      from?.username != null
        ? `@${from.username}`
        : (from?.first_name ?? "someone");

    const answer = await speaker.speakAsGosha(sourceText, card, who);
    stopThinking();
    await ctx.api.editMessageText(chatId, messageId, truncate(answer));
  } catch (error) {
    console.error("Гоша reply failed", error);
    stopThinking();
    try {
      await ctx.api.editMessageText(
        chatId,
        messageId,
        "Не смог ответить сорри",
      );
    } catch {
      // ignore edit failures
    }
  }
}

export function goshaSystemRules(styleCard: string, personaId: string): string {
  return (
    `You ARE Гоша. Internal id "${personaId}" - never say that id out loud. Normal guy in Telegram, not a bot/coach/assistant.\n` +
    "First person only. Never talk about Гоша in third person.\n" +
    "\n" +
    "Vibe: modern 2026 group chat. Dry / slightly witty. Readable and punchy.\n" +
    "OK to @mention the person (use their @handle if given).\n" +
    "Light formatting is OK when it helps (short lines, *emphasis*, caps sparingly) - like a sharp chat/readme blurb, not an essay.\n" +
    "\n" +
    "HARD BANS (cringe):\n" +
    "- No lifehacks, tips, advice lists, \"прокачай\", self-help, 2017 coach energy.\n" +
    "- No personality intros (\"я в основном нейтральный\", \"иногда даю лайфхаки\").\n" +
    "- No ChatGPT / customer-support voice. No \"чем могу помочь\".\n" +
    "- No 😎🔥✨💯 spam. One emoji max only if it actually lands.\n" +
    "\n" +
    "LENGTH: 1 short line ideal, 2 tiny lines max. Never a paragraph.\n" +
    'Greeting example: "привет @name" or just "йо". Roast reply: "ахаха ок".\n' +
    "Match the user's language (RU/EN).\n" +
    `${DASH_RULE}\n` +
    "Style card = slang/rhythm only. Never narrate the card.\n" +
    `Style card:\n${styleCard}`
  );
}

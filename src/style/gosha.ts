import type { Context } from "grammy";
import { GrammyError, InputFile } from "grammy";

import { DASH_RULE } from "../llm/types.js";
import { sleep } from "../llm/types.js";
import {
  generateCloudflareFluxImage,
  wantsImageGeneration,
} from "./image-gen.js";
import type { PersonaBot } from "./learners.js";

/**
 * Matches Гоша in common Russian cases + shorts/diminutives + Latin "gosha".
 * Includes гошик / гошанчик and case/declension variants. Case-insensitive.
 */
const GOSHA_RE =
  /(?<!\p{L})(?:гошанчик(?:а|у|е|ом|ов|ами|ах)?|гошик(?:а|у|е|ом|ов|ами|ах)?|гош(?:а|и|е|у|ей|ею|ью|ка|ки|ке|ку|кой|кою)?|gosha)(?!\p{L})/iu;

/** Hard cap - models love essays; keep Гоша chat-sized. */
const MAX_REPLY = 160;

const THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** Keep under Telegram edit rate limits (~1/s). Fast ticks kill sendPhoto after long FLUX. */
const THINKING_TICK_MS = 1_800;

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

function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof GrammyError) || error.error_code !== 429) {
    return undefined;
  }
  const params = error.parameters as { retry_after?: number } | undefined;
  const sec = params?.retry_after;
  return typeof sec === "number" && sec > 0 ? sec * 1000 : 2_000;
}

async function withTelegramRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const wait = retryAfterMs(error);
      if (wait == null || i === attempts - 1) {
        throw error;
      }
      console.warn(`${label} 429, retry in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

/**
 * Smooth sequential spinner so Telegram latency cannot freeze frames.
 */
function startThinkingAnimation(
  edit: (text: string) => Promise<void>,
  label: string,
): () => void {
  let frame = 0;
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      const text = `${THINKING_FRAMES[frame]!} ${label}`;
      frame = (frame + 1) % THINKING_FRAMES.length;
      try {
        await edit(text);
      } catch {
        // ignore flood / deleted
      }
      if (stopped) break;
      await sleep(THINKING_TICK_MS);
    }
  };

  void loop();

  return () => {
    stopped = true;
  };
}

/**
 * When a message contains "Гоша", reply once in the shared learned style.
 * Image requests -> subject as-is (no LLM enhance), then Cloudflare Workers AI.
 */
export async function handleGoshaMention(
  ctx: Context,
  speaker: PersonaBot,
  sourceText: string,
): Promise<void> {
  if (!mentionsGosha(sourceText)) {
    return;
  }

  const isImage = wantsImageGeneration(sourceText);
  const label = isImage ? "Гоша генерирует фото" : "Гоша печатает";

  const status = await ctx.reply(`${THINKING_FRAMES[0]!} ${label}`);
  const chatId = status.chat.id;
  const messageId = status.message_id;

  const stopThinking = startThinkingAnimation(async (text) => {
    await ctx.api.editMessageText(chatId, messageId, text);
  }, label);

  try {
    if (isImage) {
      const prompt = speaker.makeImagePrompt(sourceText);
      console.log(`Cloudflare FLUX prompt: ${prompt}`);
      const image = await generateCloudflareFluxImage(prompt);
      stopThinking();
      // Let in-flight spinner edits settle so sendPhoto is not rate-limited.
      await sleep(600);

      await withTelegramRetry("sendPhoto", () =>
        ctx.api.sendPhoto(chatId, new InputFile(image.bytes, "gosha.jpg")),
      );

      // Delete status only after the photo is actually delivered.
      try {
        await ctx.api.deleteMessage(chatId, messageId);
      } catch {
        // ignore
      }
      return;
    }

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
    await withTelegramRetry("editReply", () =>
      ctx.api.editMessageText(chatId, messageId, truncate(answer)),
    );
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
      try {
        await ctx.api.sendMessage(chatId, "Не смог ответить сорри");
      } catch {
        // ignore
      }
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

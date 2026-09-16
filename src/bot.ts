import { Bot, type Context } from "grammy";

import { handleAnonymize } from "./anonymize.js";
import {
  anonCommandLabels,
  isAnonCommandMessage,
  type AnonCommandSuffix,
} from "./command.js";
import {
  extractMessageText,
  handleGoshaMention,
  mentionsGosha,
} from "./style/gosha.js";
import { runGoshaInBackground } from "./style/gosha-lock.js";
import { recordUserTurn } from "./style/history.js";
import type { PersonaId, TwinLearners } from "./style/learners.js";
import {
  describeTelegramPhoto,
  formatPhotoContextText,
} from "./style/vision.js";

export type BotDeps = {
  twins?: TwinLearners;
  /**
   * Which twin this Telegram account speaks as.
   * alpha = first bot (`/m` `/с`), beta = second (`/m2` `/с2`).
   */
  personaId?: PersonaId;
  /** Command suffix owned by this bot ("" or "2"). */
  commandSuffix?: AnonCommandSuffix;
  /**
   * Shared flag: when false (solo), this bot answers every Гоша ping.
   * When true (both Telegram bots live), even→alpha / odd→beta.
   */
  twinMode?: { enabled: boolean };
};

function commandName(base: string, suffix: AnonCommandSuffix): string {
  return `${base}${suffix}`;
}

export function createBot(token: string, deps: BotDeps = {}): Bot {
  const bot = new Bot(token);
  const twins = deps.twins;
  const personaId: PersonaId = deps.personaId ?? "alpha";
  const suffix: AnonCommandSuffix = deps.commandSuffix ?? "";
  const twinMode = deps.twinMode ?? { enabled: false };
  const labels = anonCommandLabels(suffix);
  const mCmd = commandName("m", suffix);
  // Telegram Bot API command names are [a-z0-9_]; Cyrillic /с is matched via text regex.
  const enHelpCmd = commandName("m", suffix);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Anonymous messenger ready.\n\n" +
        `Send ${labels.usageLine} - I delete your message and resend it as myself.\n` +
        "Works with photos, files, voice, video, stickers, and replies.\n\n" +
        (suffix === "2"
          ? "This is the second persona bot (goscha2). Use /m2 and /с2 here; the first bot keeps /m and /с.\n"
          : "This is the first persona bot. The second bot (if configured) uses /m2 and /с2.\n") +
        "Your anon messages train a shared 30-day style profile for both AI persona bots.\n" +
        'Write "Гоша" in a message and the AI will reply once.\n' +
        "(In groups: BotFather → /setprivacy → Disable so Гоша sees the last chat messages.)",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Commands:\n" +
        `${labels.en} <text> - English alias\n` +
        `${labels.ru} <text> - Russian alias\n\n` +
        "Tips:\n" +
        `- Put the command in a media caption\n` +
        `- Reply to any message, then use ${labels.en} or ${labels.ru}\n` +
        "- In groups, make me admin with Delete messages so I can remove yours\n" +
        "- Say Гоша / Гошу / гошик (any case) for one AI reply\n" +
        "- Гоша нарисуй … → FLUX image (Cloudflare Workers AI)\n" +
        "- Group photos are described (free Gemini vision) so Гоша can see them in context\n\n" +
        "Style learning: every anon send feeds one shared corpus for both persona bots.",
    );
  });

  bot.command(enHelpCmd, async (ctx) => {
    await handleAnonymize(ctx, twins, { commandSuffix: suffix, personaId });
  });

  // Text-only into the group window (photos go through the photo handler).
  bot.on("message:text", async (ctx, next) => {
    const message = ctx.message;
    if (message && ctx.from && !ctx.from.is_bot && !message.photo) {
      recordUserTurn(message.chat.id, message);
    }
    await next();
  });

  /**
   * Photos from anyone: download → free Gemini describe → history as [photo: …].
   * Soft-fail keeps caption / "[photo]" so replies are never blocked on vision.
   * Never await vision on the webhook hot path (Telegram retries slow handlers).
   */
  bot.on("message:photo", async (ctx, next) => {
    const message = ctx.message;
    if (!message?.photo?.length || !ctx.from || ctx.from.is_bot) {
      await next();
      return;
    }

    const caption = message.caption?.trim() ?? "";
    const chatId = message.chat.id;
    const photos = message.photo;

    const wantsGoshaReply =
      Boolean(twins) &&
      Boolean(caption) &&
      mentionsGosha(caption) &&
      !isAnonCommandMessage(caption, suffix);

    if (wantsGoshaReply && twins) {
      if (twinMode.enabled) {
        const intended: PersonaId =
          message.message_id % 2 === 0 ? "alpha" : "beta";
        if (personaId !== intended) {
          // Still record history from the twin that owns this message? Skip —
          // the intended twin will record when it handles the update.
          await next();
          return;
        }
      }
      const speaker = personaId === "alpha" ? twins.alpha : twins.beta;
      // Placeholder in history immediately; enrich after vision.
      recordUserTurn(
        chatId,
        message,
        formatPhotoContextText(caption, undefined),
      );
      runGoshaInBackground(chatId, message.message_id, async () => {
        let description: string | undefined;
        try {
          description = await describeTelegramPhoto(ctx.api, photos);
        } catch (error) {
          console.warn(
            "vision describe threw",
            error instanceof Error ? error.message : error,
          );
        }
        const contextText = formatPhotoContextText(caption, description);
        recordUserTurn(chatId, message, contextText);
        await handleGoshaMention(ctx, speaker, contextText);
      });
      return;
    }

    // History only — placeholder now, enrich with vision in background.
    recordUserTurn(
      chatId,
      message,
      formatPhotoContextText(caption, undefined),
    );
    void (async () => {
      let description: string | undefined;
      try {
        description = await describeTelegramPhoto(ctx.api, photos);
      } catch (error) {
        console.warn(
          "vision describe threw",
          error instanceof Error ? error.message : error,
        );
      }
      if (!description) return;
      recordUserTurn(
        chatId,
        message,
        formatPhotoContextText(caption, description),
      );
    })();

    await next();
  });

  bot.on(["message:text", "message:caption"], async (ctx, next) => {
    const message = ctx.message;
    if (!message) {
      await next();
      return;
    }

    // Photo+Гоша already handled above; avoid double reply on caption filter.
    if (message.photo?.length) {
      await next();
      return;
    }

    const raw = message.text ?? message.caption;
    const text = extractMessageText(message);
    if (!text) {
      await next();
      return;
    }

    if (isAnonCommandMessage(raw, suffix)) {
      if (ctx.hasCommand(mCmd)) {
        await next();
        return;
      }
      await handleAnonymize(ctx, twins, { commandSuffix: suffix, personaId });
      return;
    }

    // Plain message mentioning Гоша -> one AI reply (background so webhook does not retry).
    // With two Telegram bots in the same group, only the intended twin answers
    // (even → alpha / first bot, odd → beta / second) so they do not double-reply.
    if (twins && mentionsGosha(text) && ctx.from && !ctx.from.is_bot) {
      if (twinMode.enabled) {
        const intended: PersonaId =
          message.message_id % 2 === 0 ? "alpha" : "beta";
        if (personaId !== intended) {
          await next();
          return;
        }
      }
      const speaker = personaId === "alpha" ? twins.alpha : twins.beta;
      runGoshaInBackground(message.chat.id, message.message_id, async () => {
        await handleGoshaMention(ctx, speaker, text);
      });
      return;
    }

    await next();
  });

  bot.catch((err) => {
    console.error(`bot[${personaId}] error`, err.error);
  });

  return bot;
}

export type BotContext = Context;

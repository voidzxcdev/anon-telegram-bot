import { Bot, type Context } from "grammy";

import { handleAnonymize } from "./anonymize.js";
import { isAnonCommandMessage } from "./command.js";
import {
  extractMessageText,
  handleGoshaMention,
  mentionsGosha,
} from "./style/gosha.js";
import { runGoshaInBackground } from "./style/gosha-lock.js";
import { recordUserTurn } from "./style/history.js";
import type { TwinLearners } from "./style/learners.js";

export type BotDeps = {
  twins?: TwinLearners;
};

export function createBot(token: string, deps: BotDeps = {}): Bot {
  const bot = new Bot(token);
  const twins = deps.twins;

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Anonymous messenger ready.\n\n" +
        "Send /m text or /с текст - I delete your message and resend it as myself.\n" +
        "Works with photos, files, voice, video, stickers, and replies.\n\n" +
        "Your /m and /с messages train a shared 30-day style profile for both AI persona bots.\n" +
        'Write "Гоша" in a message and the AI will reply once.\n' +
        "(In groups: BotFather → /setprivacy → Disable so Гоша sees the last chat messages.)",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Commands:\n" +
        "/m <text> - English alias\n" +
        "/с <text> - Russian alias\n\n" +
        "Tips:\n" +
        "- Put the command in a media caption\n" +
        "- Reply to any message, then use /m or /с\n" +
        "- In groups, make me admin with Delete messages so I can remove yours\n" +
        "- Say Гоша / Гошу / гошик (any case) for one AI reply\n" +
        "- Гоша нарисуй … → FLUX image (Cloudflare Workers AI)\n" +
        "- Photo-only messages are ignored by Гоша; captions are used as text\n\n" +
        "Style learning: every /m and /с feeds one shared corpus for both persona bots.",
    );
  });

  bot.command("m", async (ctx) => {
    await handleAnonymize(ctx, twins);
  });

  // Record every text/caption we see into the group-wide window (all speakers).
  // Photo-only never has caption → not recorded. Photo+caption → caption only.
  bot.on(["message:text", "message:caption"], async (ctx, next) => {
    const message = ctx.message;
    if (message && ctx.from && !ctx.from.is_bot) {
      recordUserTurn(message.chat.id, message);
    }
    await next();
  });

  bot.on(["message:text", "message:caption"], async (ctx, next) => {
    const message = ctx.message;
    if (!message) {
      await next();
      return;
    }

    const raw = message.text ?? message.caption;
    // Caption-only for photos; skip photo-only (no text for Гоша).
    const text = extractMessageText(message);
    if (!text) {
      await next();
      return;
    }

    if (isAnonCommandMessage(raw)) {
      if (ctx.hasCommand("m")) {
        await next();
        return;
      }
      await handleAnonymize(ctx, twins);
      return;
    }

    // Plain message mentioning Гоша -> one AI reply (background so webhook does not retry)
    if (twins && mentionsGosha(text) && ctx.from && !ctx.from.is_bot) {
      const speaker =
        message.message_id % 2 === 0 ? twins.alpha : twins.beta;
      runGoshaInBackground(message.chat.id, message.message_id, async () => {
        await handleGoshaMention(ctx, speaker, text);
      });
      return;
    }

    await next();
  });

  bot.catch((err) => {
    console.error("bot error", err.error);
  });

  return bot;
}

export type BotContext = Context;

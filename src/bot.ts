import { Bot, type Context } from "grammy";

import { handleAnonymize } from "./anonymize.js";
import { isAnonCommandMessage } from "./command.js";
import { handleGoshaMention, mentionsGosha } from "./style/gosha.js";
import { runGoshaInBackground } from "./style/gosha-lock.js";
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
        'Write "Гоша" in a message and the AI will reply once.',
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
        '- Say Гоша once to get a single AI reply in your learned style\n\n' +
        "Style learning: every /m and /с feeds one shared corpus for both persona bots.",
    );
  });

  bot.command("m", async (ctx) => {
    await handleAnonymize(ctx, twins);
  });

  bot.on(["message:text", "message:caption"], async (ctx, next) => {
    const raw = ctx.message?.text ?? ctx.message?.caption;
    const message = ctx.message;
    if (!message) {
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
    if (twins && mentionsGosha(raw) && ctx.from && !ctx.from.is_bot) {
      const speaker =
        message.message_id % 2 === 0 ? twins.alpha : twins.beta;
      const text = raw ?? "";
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

import { Bot, type Context } from "grammy";

import { handleAnonymize } from "./anonymize.js";
import { isAnonCommandMessage } from "./command.js";
import type { TwinLearners } from "./style/learners.js";
import { handleGoshaMention, mentionsGosha } from "./style/gosha.js";

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
        'Write "Гоша" in a message and the AI will reply.',
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
        '- Say Гоша in a message to get an AI reply in your learned style\n\n' +
        "Style learning: every /m and /с feeds one shared corpus for both persona bots.",
    );
  });

  bot.command("m", async (ctx) => {
    await handleAnonymize(ctx, twins);
  });

  bot.on(["message:text", "message:caption"], async (ctx, next) => {
    const raw = ctx.message?.text ?? ctx.message?.caption;

    if (isAnonCommandMessage(raw)) {
      if (ctx.hasCommand("m")) {
        await next();
        return;
      }
      await handleAnonymize(ctx, twins);
      return;
    }

    // Plain message mentioning Гоша -> AI reply (needs OpenCode + twins)
    if (twins && mentionsGosha(raw) && ctx.from && !ctx.from.is_bot) {
      // Alternate speakers so both personas get practice; shared style either way.
      const speaker =
        (ctx.message?.message_id ?? 0) % 2 === 0 ? twins.alpha : twins.beta;
      await handleGoshaMention(ctx, speaker, raw ?? "");
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

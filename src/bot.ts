import { Bot, type Context } from "grammy";

import { handleAnonymize } from "./anonymize.js";
import { isAnonCommandMessage } from "./command.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Anonymous messenger ready.\n\n" +
        "Send /m text or /с текст — I delete your message and resend it as myself.\n" +
        "Works with photos, files, voice, video, stickers, and replies.\n\n" +
        "Your /m and /с messages also train a shared 30-day style profile " +
        "used by both AI persona bots (even if you only talk to this one).",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Commands:\n" +
        "/m <text> — English alias\n" +
        "/с <text> — Russian alias\n\n" +
        "Tips:\n" +
        "• Put the command in a media caption\n" +
        "• Reply to any message, then use /m or /с\n" +
        "• In groups, make me admin with Delete messages so I can remove yours\n\n" +
        "Style learning: every /m and /с feeds one shared corpus for both persona bots.",
    );
  });

  // Latin /m via Bot API command entity
  bot.command("m", async (ctx) => {
    await handleAnonymize(ctx);
  });

  // Cyrillic /с may not register as a bot_command entity — match text/caption too.
  bot.on(["message:text", "message:caption"], async (ctx, next) => {
    const raw = ctx.message?.text ?? ctx.message?.caption;
    if (!isAnonCommandMessage(raw)) {
      await next();
      return;
    }
    // Avoid double-handling when Telegram already routed /m through bot.command
    if (ctx.hasCommand("m")) {
      await next();
      return;
    }
    await handleAnonymize(ctx);
  });

  bot.catch((err) => {
    console.error("bot error", err.error);
  });

  return bot;
}

export type BotContext = Context;

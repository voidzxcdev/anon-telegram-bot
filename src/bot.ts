import { Bot, type Context } from "grammy";

import { handleAnonymize } from "./anonymize.js";
import { isAnonCommandMessage } from "./command.js";
import { handleAi } from "./llm/ai-command.js";
import type { OpenCodeClient } from "./llm/opencode.js";

export type BotDeps = {
  llm?: OpenCodeClient;
};

export function createBot(token: string, deps: BotDeps = {}): Bot {
  const bot = new Bot(token);
  const { llm } = deps;

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Anonymous messenger ready.\n\n" +
        "Send /m text or /с текст — I delete your message and resend it as myself.\n" +
        "Works with photos, files, voice, video, stickers, and replies.\n\n" +
        (llm
          ? "AI: /ai your question (Muse Spark 1.3 Contributor Free via OpenCode Zen)"
          : "AI: not configured (set OPENCODE_API_KEY)"),
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Commands:\n" +
        "/m <text> — English alias\n" +
        "/с <text> — Russian alias\n" +
        (llm ? "/ai <prompt> — Muse Spark free (OpenCode Zen)\n" : "") +
        "\nTips:\n" +
        "• Put the command in a media caption\n" +
        "• Reply to any message, then use /m or /с\n" +
        "• In groups, make me admin with Delete messages so I can remove yours\n" +
        (llm
          ? "\nPrivacy: Contributor Free may train Meta on your /ai prompts."
          : ""),
    );
  });

  // Latin /m via Bot API command entity
  bot.command("m", async (ctx) => {
    await handleAnonymize(ctx);
  });

  if (llm) {
    bot.command("ai", async (ctx) => {
      await handleAi(ctx, llm);
    });
  }

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

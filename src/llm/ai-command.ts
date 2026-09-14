import type { Context } from "grammy";

import type { OpenCodeClient } from "../llm/opencode.js";

const MAX_TELEGRAM_REPLY = 4000;

function truncate(text: string): string {
  if (text.length <= MAX_TELEGRAM_REPLY) {
    return text;
  }
  return `${text.slice(0, MAX_TELEGRAM_REPLY - 20)}\n\n…(truncated)`;
}

export async function handleAi(ctx: Context, llm: OpenCodeClient): Promise<void> {
  const prompt = (ctx.match as string | undefined)?.trim();
  if (!prompt) {
    await ctx.reply(
      "Usage: /ai your question\n\n" +
        `Model: ${llm.model}\n` +
        "Note: Contributor Free may use prompts to train Meta models (limited-time free).",
    );
    return;
  }

  const status = await ctx.reply("Thinking…");

  try {
    const answer = await llm.complete([
      {
        role: "system",
        content:
          "You are a helpful assistant inside a Telegram anonymous-messenger bot. " +
          "Be concise and clear. Match the user's language (English or Russian).",
      },
      { role: "user", content: prompt },
    ]);

    await ctx.api.editMessageText(
      status.chat.id,
      status.message_id,
      truncate(answer),
    );
  } catch (error) {
    console.error("OpenCode /ai failed", error);
    const detail =
      error instanceof Error ? error.message.slice(0, 200) : "unknown error";
    await ctx.api.editMessageText(
      status.chat.id,
      status.message_id,
      `AI request failed: ${detail}`,
    );
  }
}

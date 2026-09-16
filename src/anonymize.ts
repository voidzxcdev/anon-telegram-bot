import type { Context } from "grammy";
import type { Message, ReplyParameters } from "grammy/types";

import {
  anonCommandLabels,
  parseAnonCommand,
  type AnonCommandSuffix,
} from "./command.js";
import { captureStyleFromAnonMessage } from "./style/capture.js";
import { handleGoshaMention, mentionsGosha } from "./style/gosha.js";
import { runGoshaInBackground } from "./style/gosha-lock.js";
import type { PersonaId, TwinLearners } from "./style/learners.js";

export type AnonymizeOpts = {
  commandSuffix?: AnonCommandSuffix;
  personaId?: PersonaId;
};

function replyParameters(
  messageId: number | undefined,
): ReplyParameters | undefined {
  if (messageId === undefined) {
    return undefined;
  }
  return { message_id: messageId };
}

type CaptionOpts = {
  caption?: string;
  reply_parameters?: ReplyParameters;
};

function mediaOptions(
  payload: string,
  replyToMessageId: number | undefined,
): CaptionOpts {
  const opts: CaptionOpts = {};
  const reply = replyParameters(replyToMessageId);
  if (reply) {
    opts.reply_parameters = reply;
  }
  if (payload.length > 0) {
    opts.caption = payload;
  }
  return opts;
}

async function sendText(
  ctx: Context,
  chatId: number,
  text: string,
  replyToMessageId: number | undefined,
): Promise<void> {
  const reply = replyParameters(replyToMessageId);
  if (reply) {
    await ctx.api.sendMessage(chatId, text, { reply_parameters: reply });
    return;
  }
  await ctx.api.sendMessage(chatId, text);
}

/**
 * Re-sends the user message as the bot (no forward header), stripping /m or /с.
 * Supports text + common media types; preserves reply threading.
 */
export async function sendAnonymousCopy(
  ctx: Context,
  source: Message,
  payload: string,
): Promise<void> {
  const chatId = source.chat.id;
  const replyTo = source.reply_to_message?.message_id;
  const api = ctx.api;
  const opts = mediaOptions(payload, replyTo);

  if (source.photo?.length) {
    const largest = source.photo.at(-1);
    if (!largest) {
      throw new Error("Photo sizes missing");
    }
    await api.sendPhoto(chatId, largest.file_id, opts);
    return;
  }

  if (source.animation) {
    await api.sendAnimation(chatId, source.animation.file_id, opts);
    return;
  }

  if (source.video) {
    await api.sendVideo(chatId, source.video.file_id, opts);
    return;
  }

  if (source.document) {
    await api.sendDocument(chatId, source.document.file_id, opts);
    return;
  }

  if (source.audio) {
    await api.sendAudio(chatId, source.audio.file_id, opts);
    return;
  }

  if (source.voice) {
    await api.sendVoice(chatId, source.voice.file_id, opts);
    return;
  }

  if (source.video_note) {
    const reply = replyParameters(replyTo);
    if (reply) {
      await api.sendVideoNote(chatId, source.video_note.file_id, {
        reply_parameters: reply,
      });
    } else {
      await api.sendVideoNote(chatId, source.video_note.file_id);
    }
    if (payload.length > 0) {
      await sendText(ctx, chatId, payload, replyTo);
    }
    return;
  }

  if (source.sticker) {
    const reply = replyParameters(replyTo);
    if (reply) {
      await api.sendSticker(chatId, source.sticker.file_id, {
        reply_parameters: reply,
      });
    } else {
      await api.sendSticker(chatId, source.sticker.file_id);
    }
    if (payload.length > 0) {
      await sendText(ctx, chatId, payload, replyTo);
    }
    return;
  }

  if (payload.length > 0) {
    await sendText(ctx, chatId, payload, replyTo);
    return;
  }

  throw new Error("Nothing to send: empty payload and no supported media");
}

export async function handleAnonymize(
  ctx: Context,
  twins?: TwinLearners,
  opts: AnonymizeOpts = {},
): Promise<void> {
  const message = ctx.message;
  if (!message) {
    return;
  }

  const suffix: AnonCommandSuffix = opts.commandSuffix ?? "";
  const personaId: PersonaId = opts.personaId ?? "alpha";
  const labels = anonCommandLabels(suffix);

  const raw = message.text ?? message.caption;
  const parsed = parseAnonCommand(raw, suffix);
  if (!parsed) {
    return;
  }

  const hasMedia = Boolean(
    message.photo ||
      message.video ||
      message.document ||
      message.audio ||
      message.voice ||
      message.video_note ||
      message.animation ||
      message.sticker,
  );

  if (!parsed.payload && !hasMedia) {
    await ctx.reply(
      "Usage:\n" +
        `- ${labels.en} your text\n` +
        `- ${labels.ru} ваш текст\n` +
        `- Attach a photo/file and put ${labels.en} or ${labels.ru} in the caption\n` +
        `- Reply to a message, then ${labels.en} or ${labels.ru} to answer anonymously`,
    );
    return;
  }

  try {
    await sendAnonymousCopy(ctx, message, parsed.payload);
  } catch (error) {
    console.error("anonymous send failed", error);
    await ctx.reply("Could not send that anonymously. Try again.");
    return;
  }

  try {
    await captureStyleFromAnonMessage(message);
  } catch (error) {
    console.warn("style capture failed", error);
  }

  try {
    await ctx.deleteMessage();
  } catch (error) {
    // Needs "Delete messages" in groups; private chats often block deleting user msgs.
    console.warn("could not delete original message", error);
  }

  // Anon send containing Гоша -> one AI reply (background; no webhook spam).
  // This bot only speaks as its bound persona.
  if (twins && (mentionsGosha(parsed.payload) || mentionsGosha(raw))) {
    const speaker = personaId === "alpha" ? twins.alpha : twins.beta;
    const text = (parsed.payload || raw || "").trim();
    if (text) {
      runGoshaInBackground(message.chat.id, message.message_id, async () => {
        await handleGoshaMention(ctx, speaker, text);
      });
    }
  }
}

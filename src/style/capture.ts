import type { Message } from "grammy/types";

import { parseAnonCommand } from "../command.js";
import {
  getSharedStyleStore,
  inferMediaKind,
  type StyleStore,
} from "./store.js";

/**
 * After a successful /m or /с send, record the utterance into the shared
 * 30-day corpus. Both persona bots learn from this same store.
 */
export async function captureStyleFromAnonMessage(
  message: Message,
  store: StyleStore = getSharedStyleStore(),
): Promise<void> {
  const raw = message.text ?? message.caption;
  const parsed = parseAnonCommand(raw);
  if (!parsed) {
    return;
  }

  const from = message.from;
  if (!from || from.is_bot) {
    return;
  }

  const command = raw?.trimStart().startsWith("/с") ? "с" : "m";
  const text = parsed.payload;
  const media = inferMediaKind(message);

  // Skip empty text-only noise (usage prompts already blocked upstream)
  if (!text && media === "text") {
    return;
  }

  await store.record({
    chatId: message.chat.id,
    userId: from.id,
    command,
    text,
    media,
    isReply: Boolean(message.reply_to_message),
  });
}

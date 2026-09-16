/**
 * In-memory ring buffer of recent *group chat* messages for Гоша LLM context.
 *
 * Window = last N messages from EVERYONE in the chat (all members + Гоша),
 * not a per-user DM transcript. Telegram bots cannot fetch history via API,
 * so we only remember updates the bot actually receives (disable BotFather
 * privacy mode /setprivacy → Disable so the bot sees all group traffic).
 */

export type ChatTurn = {
  role: "user" | "assistant";
  /** Display name or @handle for humans; "Гоша" for bot replies. */
  name: string;
  text: string;
  at: number;
  messageId: number;
};

const MAX_TURNS = 40;
/** Messages passed into the LLM (oldest → newest). */
export const CONTEXT_LIMIT = 25;

const byChat = new Map<number, ChatTurn[]>();

function speakerLabel(from: {
  username?: string;
  first_name?: string;
} | undefined): string {
  if (!from) return "someone";
  if (from.username) return `@${from.username}`;
  return from.first_name ?? "someone";
}

/**
 * Record a human message into the group-wide window.
 * - Photo-only (no caption): skipped
 * - Photo + caption: caption text only (image ignored)
 * - Bot senders: skipped (Гоша replies go through recordGoshaTurn)
 */
export function recordUserTurn(
  chatId: number,
  message: {
    message_id: number;
    text?: string;
    caption?: string;
    photo?: unknown;
    from?: { username?: string; first_name?: string; is_bot?: boolean };
  },
): void {
  if (message.from?.is_bot) return;

  const text = (message.text ?? message.caption ?? "").trim();
  // Photo-only or empty: nothing for the model to read.
  if (!text) return;

  pushTurn(chatId, {
    role: "user",
    name: speakerLabel(message.from),
    text: text.slice(0, 500),
    at: Date.now(),
    messageId: message.message_id,
  });
}

export function recordGoshaTurn(
  chatId: number,
  messageId: number,
  text: string,
): void {
  const cleaned = text.trim();
  if (!cleaned) return;
  pushTurn(chatId, {
    role: "assistant",
    name: "Гоша",
    text: cleaned.slice(0, 500),
    at: Date.now(),
    messageId,
  });
}

function pushTurn(chatId: number, turn: ChatTurn): void {
  const list = byChat.get(chatId) ?? [];
  // Dedupe webhook retries of the same message id + role.
  if (list.some((t) => t.messageId === turn.messageId && t.role === turn.role)) {
    return;
  }
  list.push(turn);
  while (list.length > MAX_TURNS) list.shift();
  byChat.set(chatId, list);
}

/**
 * Last up to `limit` text turns in this chat from all speakers
 * (oldest → newest). Includes other members and prior Гоша replies.
 */
export function getRecentContext(
  chatId: number,
  limit = CONTEXT_LIMIT,
): ChatTurn[] {
  const list = byChat.get(chatId) ?? [];
  if (list.length <= limit) return [...list];
  return list.slice(-limit);
}

/** Format the group window for the LLM prompt. */
export function formatContextForPrompt(turns: ChatTurn[]): string {
  if (turns.length === 0) return "";
  return turns
    .map((t) => {
      const who = t.role === "assistant" ? "Гоша" : t.name;
      return `${who}: ${t.text}`;
    })
    .join("\n");
}

/** Test helper — clear buffers. */
export function clearChatHistory(chatId?: number): void {
  if (chatId == null) {
    byChat.clear();
    return;
  }
  byChat.delete(chatId);
}

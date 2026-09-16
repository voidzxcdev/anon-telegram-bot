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

/** Keep a little headroom above the LLM window. */
const MAX_TURNS = 80;
/** Messages passed into the LLM (oldest → newest). Prefer 50 for chatter + mentions. */
export const CONTEXT_LIMIT = 50;

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
 * - Text / caption: used as-is
 * - Photos: pass `overrideText` from vision (`[photo: …]` + caption)
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
  /** When set (e.g. vision description), used instead of text/caption. */
  overrideText?: string,
): void {
  if (message.from?.is_bot) return;

  const text = (overrideText ?? message.text ?? message.caption ?? "").trim();
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
  const existing = list.find(
    (t) => t.messageId === turn.messageId && t.role === turn.role,
  );
  if (existing) {
    // Enrich photo placeholders when vision finishes (same message id).
    if (turn.text.length > existing.text.length) {
      existing.text = turn.text;
      existing.at = turn.at;
    }
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

/**
 * Chat ids that had any human traffic recently (for proactive chatter).
 * Defaults to activity within the last 6 hours.
 */
export function listActiveChatIds(
  maxAgeMs = 6 * 60 * 60 * 1000,
): number[] {
  const cutoff = Date.now() - maxAgeMs;
  const ids: number[] = [];
  for (const [chatId, turns] of byChat) {
    // Telegram groups/supergroups/channels use negative ids; skip private DMs.
    if (chatId >= 0) continue;
    if (turns.some((t) => t.role === "user" && t.at >= cutoff)) {
      ids.push(chatId);
    }
  }
  return ids;
}

/** Test helper — clear buffers. */
export function clearChatHistory(chatId?: number): void {
  if (chatId == null) {
    byChat.clear();
    return;
  }
  byChat.delete(chatId);
}

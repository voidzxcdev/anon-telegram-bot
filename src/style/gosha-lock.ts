/**
 * Prevents Гоша reply spam from Telegram webhook retries
 * while a long LLM call is still running.
 */

const inflightChats = new Set<number>();
const inflightMessages = new Set<string>();
const lastReplyAt = new Map<number, number>();

const COOLDOWN_MS = 10_000;

export function tryAcquireGoshaLock(
  chatId: number,
  messageId: number,
): boolean {
  const msgKey = `${chatId}:${messageId}`;
  if (inflightMessages.has(msgKey) || inflightChats.has(chatId)) {
    return false;
  }
  const last = lastReplyAt.get(chatId) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    return false;
  }
  inflightMessages.add(msgKey);
  inflightChats.add(chatId);
  return true;
}

export function releaseGoshaLock(chatId: number, messageId: number): void {
  inflightMessages.delete(`${chatId}:${messageId}`);
  inflightChats.delete(chatId);
  lastReplyAt.set(chatId, Date.now());
}

/** Fire-and-forget wrapper so webhook can ACK before LLM finishes. */
export function runGoshaInBackground(
  chatId: number,
  messageId: number,
  work: () => Promise<void>,
): void {
  if (!tryAcquireGoshaLock(chatId, messageId)) {
    console.warn(`Гоша skipped (lock/cooldown) chat=${chatId} msg=${messageId}`);
    return;
  }
  void work().finally(() => {
    releaseGoshaLock(chatId, messageId);
  });
}

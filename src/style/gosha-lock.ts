/**
 * Dedupes Telegram webhook retries for the same messageId
 * so a long LLM call is not started twice for one update.
 * Does not block other messages in the same chat.
 */

const inflightMessages = new Set<string>();

export function tryAcquireGoshaLock(
  chatId: number,
  messageId: number,
): boolean {
  const msgKey = `${chatId}:${messageId}`;
  if (inflightMessages.has(msgKey)) {
    return false;
  }
  inflightMessages.add(msgKey);
  return true;
}

export function releaseGoshaLock(chatId: number, messageId: number): void {
  inflightMessages.delete(`${chatId}:${messageId}`);
}

/** Fire-and-forget wrapper so webhook can ACK before LLM finishes. */
export function runGoshaInBackground(
  chatId: number,
  messageId: number,
  work: () => Promise<void>,
): void {
  if (!tryAcquireGoshaLock(chatId, messageId)) {
    console.warn(
      `Гоша skipped (duplicate messageId) chat=${chatId} msg=${messageId}`,
    );
    return;
  }
  void work().finally(() => {
    releaseGoshaLock(chatId, messageId);
  });
}

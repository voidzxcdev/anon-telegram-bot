/** Shared LLM types + text rules (provider-agnostic). */

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompleteOptions = {
  maxTokens?: number;
};

export type LlmClient = {
  /** Last model that succeeded (or primary if none yet). */
  model: string;
  complete: (
    messages: ChatMessage[],
    options?: CompleteOptions,
  ) => Promise<string>;
};

/** @deprecated use LlmClient */
export type OpenCodeClient = LlmClient;

export const DASH_RULE =
  'Never use em-dashes or en-dashes. Always use a plain hyphen "-" instead.';

export function normalizeDashes(text: string): string {
  return text.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, "-");
}

export function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: number }).status;
    if (status === 429) return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit|too many requests|quota/i.test(msg);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

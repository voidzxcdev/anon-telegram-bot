/**
 * Matches `/m` (English) and `/с` (Russian Cyrillic "es").
 * Supports optional @BotUsername and an optional payload after whitespace.
 */
const ANON_COMMAND =
  /^\/(m|с)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/u;

export type ParsedAnonCommand = {
  /** Text after the command (may be empty). */
  payload: string;
};

export function parseAnonCommand(
  text: string | undefined,
): ParsedAnonCommand | undefined {
  if (!text) {
    return undefined;
  }

  const match = ANON_COMMAND.exec(text.trimEnd());
  if (!match) {
    return undefined;
  }

  return { payload: (match[2] ?? "").trim() };
}

export function isAnonCommandMessage(
  text: string | undefined,
): boolean {
  return parseAnonCommand(text) !== undefined;
}

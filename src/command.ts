/**
 * Anonymous-send commands.
 * - First bot (alpha): `/m` and `/с`
 * - Second bot (beta / goscha2): `/m2` and `/с2`
 * Supports optional @BotUsername and an optional payload after whitespace.
 */

export type AnonCommandSuffix = "" | "2";

export type ParsedAnonCommand = {
  /** Text after the command (may be empty). */
  payload: string;
  /** "" for first bot, "2" for second. */
  suffix: AnonCommandSuffix;
};

function anonCommandRe(suffix: AnonCommandSuffix): RegExp {
  // Cyrillic "с" + optional "2" for the second bot namespace.
  const tail = suffix === "2" ? "2" : "";
  return new RegExp(
    `^\\/(m|с)${tail}(?:@[A-Za-z0-9_]+)?(?:\\s+([\\s\\S]*))?$`,
    "u",
  );
}

export function parseAnonCommand(
  text: string | undefined,
  suffix: AnonCommandSuffix = "",
): ParsedAnonCommand | undefined {
  if (!text) {
    return undefined;
  }

  const match = anonCommandRe(suffix).exec(text.trimEnd());
  if (!match) {
    return undefined;
  }

  return { payload: (match[2] ?? "").trim(), suffix };
}

export function isAnonCommandMessage(
  text: string | undefined,
  suffix: AnonCommandSuffix = "",
): boolean {
  return parseAnonCommand(text, suffix) !== undefined;
}

/** Help / start blurbs for the command namespace this bot owns. */
export function anonCommandLabels(suffix: AnonCommandSuffix): {
  en: string;
  ru: string;
  usageLine: string;
} {
  if (suffix === "2") {
    return {
      en: "/m2",
      ru: "/с2",
      usageLine: "/m2 text or /с2 текст",
    };
  }
  return {
    en: "/m",
    ru: "/с",
    usageLine: "/m text or /с текст",
  };
}

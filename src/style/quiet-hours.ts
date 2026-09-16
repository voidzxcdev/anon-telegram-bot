/**
 * Quiet hours for proactive Гоша chatter: 23:00–07:00 Europe/Berlin.
 * Outside that window, chatter may fire ~every 15 minutes.
 */

export const QUIET_TZ = "Europe/Berlin";
/** Inclusive start hour (23:00). */
export const QUIET_START_HOUR = 23;
/** Exclusive end hour (07:00 → quiet while hour < 7). */
export const QUIET_END_HOUR = 7;

/** Berlin wall-clock hour 0–23 for a given instant. */
export function berlinHour(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: QUIET_TZ,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = parts.find((p) => p.type === "hour")?.value;
  return Number(hour ?? "0");
}

/**
 * True when proactive chatter must stay silent
 * (Berlin local time in [23:00, 07:00)).
 */
export function isQuietHours(at: Date = new Date()): boolean {
  const hour = berlinHour(at);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

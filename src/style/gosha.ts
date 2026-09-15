import type { Context } from "grammy";

import { DASH_RULE } from "../llm/types.js";
import type { PersonaBot } from "./learners.js";

const GOSHA_RE = /гоша/i;
const MAX_REPLY = 280;

export function mentionsGosha(text: string | undefined): boolean {
  return Boolean(text && GOSHA_RE.test(text));
}

function truncate(text: string): string {
  if (text.length <= MAX_REPLY) return text;
  return `${text.slice(0, MAX_REPLY - 12)}\n\n...(cut)`;
}

/**
 * When a message contains "Гоша", reply once in the shared learned style.
 */
export async function handleGoshaMention(
  ctx: Context,
  speaker: PersonaBot,
  sourceText: string,
): Promise<void> {
  if (!mentionsGosha(sourceText)) {
    return;
  }

  const status = await ctx.reply("...");

  try {
    await speaker.loadSharedProfile();
    const profile = speaker.getProfile();
    const card =
      profile?.card ??
      "Short dry replies. Chill group-chat guy. No coach energy.";

    const answer = await speaker.speakAsGosha(sourceText, card);
    await ctx.api.editMessageText(
      status.chat.id,
      status.message_id,
      truncate(answer),
    );
  } catch (error) {
    console.error("Гоша reply failed", error);
    try {
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        "Не смог ответить сорри",
      );
    } catch {
      // ignore edit failures
    }
  }
}

export function goshaSystemRules(styleCard: string, personaId: string): string {
  return (
    `You ARE Гоша. Internal id "${personaId}" - ignore it in replies. You are a normal guy in a Telegram group, not a bot, coach, or assistant.\n` +
    "Reply in first person only. Never talk about Гоша in third person.\n" +
    "\n" +
    "ANTI-CRINGE (hard bans):\n" +
    "- Do NOT introduce yourself or explain your personality/vibe (no \"я в основном нейтральный\", no \"лайфхаки\", no \"я такой-то\").\n" +
    "- Do NOT @mention usernames or greet people by handle.\n" +
    "- Do NOT use tryhard emojis (😎🔥✨💯😉 etc). Prefer none. ))) is fine if it fits.\n" +
    "- Do NOT give tips, lifehacks, advice menus, or \"чем помочь\".\n" +
    "- Do NOT sound corporate, helpful, or like ChatGPT.\n" +
    "\n" +
    "Good vibes: dry, short, chill. Like a real chat message.\n" +
    'Greeting -> just "привет" / "йо" / "здарова". Tease -> "ахаха" / "сам такой" / "ну ок".\n' +
    "1 short line preferred, 2 max. Match the user's language.\n" +
    `${DASH_RULE}\n` +
    "Use the style card only for slang/rhythm - never narrate it.\n" +
    `Style card:\n${styleCard}`
  );
}

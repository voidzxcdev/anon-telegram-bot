import { createBot } from "./bot.js";
import { loadEnv } from "./env.js";
import { createOpenCodeClient } from "./llm/opencode.js";
import { registerWebhook, startWebhookServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadEnv();

  const llm = env.OPENCODE_API_KEY
    ? createOpenCodeClient(env.OPENCODE_API_KEY, {
        model: env.OPENCODE_MODEL,
        baseURL: env.OPENCODE_BASE_URL,
      })
    : undefined;

  if (llm) {
    console.log(`OpenCode Zen enabled: model=${llm.model}`);
  } else {
    console.warn("OPENCODE_API_KEY not set — /ai disabled");
  }

  const bot = llm
    ? createBot(env.TELEGRAM_BOT_TOKEN, { llm })
    : createBot(env.TELEGRAM_BOT_TOKEN);

  // Bring HTTP up first so Render health checks pass while Telegram is configured.
  if (env.publicBaseUrl) {
    startWebhookServer(bot, env);
  }

  let me;
  try {
    me = await bot.api.getMe();
  } catch (error) {
    console.error(
      "TELEGRAM_BOT_TOKEN is invalid or revoked (getMe failed).",
      "Create a new token in @BotFather and update the Render env var.",
      error,
    );
    // Keep the process alive in webhook mode so /health stays up for ops.
    if (env.publicBaseUrl) {
      return;
    }
    throw error;
  }

  console.log(`bot @${me.username} ready`);

  try {
    const commands = [
      { command: "start", description: "How this bot works" },
      { command: "help", description: "Usage for /m and /с" },
      { command: "m", description: "Send an anonymous message" },
    ];
    if (llm) {
      commands.push({
        command: "ai",
        description: "Ask Muse Spark (OpenCode free)",
      });
    }
    await bot.api.setMyCommands(commands);
  } catch (error) {
    console.warn("setMyCommands failed (non-fatal)", error);
  }

  if (env.publicBaseUrl) {
    try {
      const webhookUrl = await registerWebhook(bot, env);
      console.log(`webhook set: ${webhookUrl}`);
    } catch (error) {
      console.error("setWebhook failed", error);
    }
    return;
  }

  console.log("no public URL — starting long polling (local/dev)");
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  await bot.start({
    onStart: () => console.log("polling started"),
  });
}

main().catch((error) => {
  console.error("fatal", error);
  process.exit(1);
});

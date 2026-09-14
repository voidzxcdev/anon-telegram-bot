import { createBot } from "./bot.js";
import { loadEnv } from "./env.js";
import { registerWebhook, startWebhookServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const bot = createBot(env.TELEGRAM_BOT_TOKEN);

  await bot.api.setMyCommands([
    { command: "start", description: "How this bot works" },
    { command: "help", description: "Usage for /m and /с" },
    { command: "m", description: "Send an anonymous message" },
  ]);

  const me = await bot.api.getMe();
  console.log(`bot @${me.username} ready`);

  if (env.publicBaseUrl) {
    startWebhookServer(bot, env);
    const webhookUrl = await registerWebhook(bot, env);
    console.log(`webhook set: ${webhookUrl}`);
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

import { createBot } from "./bot.js";
import { loadEnv } from "./env.js";
import { createLlmClient, parseOpenRouterKeys } from "./llm/client.js";
import { registerWebhook, startKeepAlive, startWebhookServer } from "./server.js";
import { createTwinLearners } from "./style/learners.js";

const TRAIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function main(): Promise<void> {
  const env = loadEnv();

  const openRouterKeys = parseOpenRouterKeys(
    env.OPENROUTER_API_KEYS ?? env.OPENROUTER_API_KEY,
  );
  if (
    openRouterKeys.length === 0 &&
    !env.GROQ_API_KEY &&
    !env.GEMINI_API_KEY
  ) {
    throw new Error(
      "Set GROQ_API_KEY and/or GEMINI_API_KEY and/or OPENROUTER_API_KEYS",
    );
  }

  const llm = createLlmClient({
    ...(openRouterKeys.length > 0 ? { openRouterKeys } : {}),
    ...(env.OPENROUTER_MODEL ? { openRouterModel: env.OPENROUTER_MODEL } : {}),
    ...(env.GROQ_API_KEY ? { groqApiKey: env.GROQ_API_KEY } : {}),
    ...(env.GEMINI_API_KEY ? { geminiApiKey: env.GEMINI_API_KEY } : {}),
    ...(env.publicBaseUrl ? { siteUrl: env.publicBaseUrl } : {}),
  });

  // Both persona bots share one StyleStore — /m or /с on this Telegram bot trains both.
  const twins = createTwinLearners(llm);
  await twins.store.init();
  await twins.alpha.loadSharedProfile();
  await twins.beta.loadSharedProfile();

  const sampleCount = (await twins.store.listRecent()).length;
  console.log(
    `style corpus: ${sampleCount} samples (30d); profile=${Boolean(twins.alpha.getProfile())}`,
  );

  const providers = [
    env.GROQ_API_KEY ? "groq" : null,
    env.GEMINI_API_KEY ? "gemini" : null,
    openRouterKeys.length > 0 ? `openrouter(${openRouterKeys.length})` : null,
  ].filter(Boolean);
  console.log(`LLM ready: ${llm.model} [${providers.join(" → ")}]`);
  const runTrain = async (reason: string) => {
    try {
      const profile = await twins.alpha.learnFromSharedCorpus();
      if (profile) {
        await twins.beta.loadSharedProfile();
        console.log(
          `style distilled (${reason}): samples=${profile.sampleCount} at ${profile.updatedAt}`,
        );
      } else {
        console.log(`style train skipped (${reason}): no /m or /с samples yet`);
      }
    } catch (error) {
      console.warn(`style train failed (${reason})`, error);
    }
  };

  void runTrain("startup");
  setInterval(() => {
    void runTrain("interval");
  }, TRAIN_INTERVAL_MS);

  const bot = createBot(env.TELEGRAM_BOT_TOKEN, { twins });

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
    if (env.publicBaseUrl) {
      return;
    }
    throw error;
  }

  console.log(`bot @${me.username} ready`);

  try {
    await bot.api.setMyCommands([
      { command: "start", description: "How this bot works" },
      { command: "help", description: "Usage for /m and /с" },
      { command: "m", description: "Send an anonymous message" },
    ]);
  } catch (error) {
    console.warn("setMyCommands failed (non-fatal)", error);
  }

  if (env.publicBaseUrl) {
    try {
      const webhookUrl = await registerWebhook(bot, env);
      console.log(`webhook set: ${webhookUrl}`);
      startKeepAlive(env.publicBaseUrl);
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

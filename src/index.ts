import { createBot } from "./bot.js";
import { loadEnv } from "./env.js";
import { createLlmClient } from "./llm/client.js";
import { registerWebhook, startWebhookServer } from "./server.js";
import { createTwinLearners } from "./style/learners.js";

const TRAIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function main(): Promise<void> {
  const env = loadEnv();

  const llm = createLlmClient({
    ...(env.GEMINI_API_KEY ? { geminiApiKey: env.GEMINI_API_KEY } : {}),
    ...(env.GROQ_API_KEY ? { groqApiKey: env.GROQ_API_KEY } : {}),
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

  if (llm) {
    console.log(`LLM ready: ${llm.model} (Gemini + Groq fallbacks)`);
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
  } else {
    console.warn(
      "No GEMINI_API_KEY / GROQ_API_KEY — still recording /m+/с; Гоша replies disabled",
    );
  }

  const bot = createBot(
    env.TELEGRAM_BOT_TOKEN,
    llm ? { twins } : {},
  );

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

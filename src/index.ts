import { createBot } from "./bot.js";
import { loadEnv } from "./env.js";
import { createOpenCodeClient } from "./llm/opencode.js";
import { registerWebhook, startWebhookServer } from "./server.js";
import { createTwinLearners } from "./style/learners.js";

const TRAIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function main(): Promise<void> {
  const env = loadEnv();

  const llm = env.OPENCODE_API_KEY
    ? createOpenCodeClient(env.OPENCODE_API_KEY, {
        model: env.OPENCODE_MODEL,
        baseURL: env.OPENCODE_BASE_URL,
      })
    : undefined;

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
    console.log(`OpenCode Zen trainer: model=${llm.model}`);
    const runTrain = async (reason: string) => {
      try {
        // Either twin can trigger; both read the same resulting profile.
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

    // Initial distill after boot (non-blocking for webhook listen)
    void runTrain("startup");
    setInterval(() => {
      void runTrain("interval");
    }, TRAIN_INTERVAL_MS);
  } else {
    console.warn(
      "OPENCODE_API_KEY not set — still recording /m+/с samples; distillation disabled",
    );
  }

  const bot = createBot(env.TELEGRAM_BOT_TOKEN);

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

import type { Bot } from "grammy";

import { createBot } from "./bot.js";
import { loadEnv } from "./env.js";
import { createLlmClient, parseOpenRouterKeys } from "./llm/client.js";
import {
  registerWebhook,
  startKeepAlive,
  startWebhookServer,
  type WebhookBot,
} from "./server.js";
import {
  chatterFromBot,
  startProactiveChatter,
} from "./style/chatter.js";
import { setCloudflareImageConfig } from "./style/image-gen.js";
import { createTwinLearners } from "./style/learners.js";

const TRAIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function bootBot(
  bot: Bot,
  label: string,
  commands: Array<{ command: string; description: string }>,
): Promise<string | undefined> {
  let me;
  try {
    me = await bot.api.getMe();
  } catch (error) {
    console.error(
      `${label} token is invalid or revoked (getMe failed).`,
      "Create a new token in @BotFather and update the Render env var.",
      error,
    );
    return undefined;
  }

  console.log(`${label} @${me.username} ready`);

  try {
    await bot.api.setMyCommands(commands);
  } catch (error) {
    console.warn(`${label} setMyCommands failed (non-fatal)`, error);
  }

  return me.username;
}

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

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    setCloudflareImageConfig({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      ...(env.CLOUDFLARE_AI_GATEWAY_URL
        ? { gatewayUrl: env.CLOUDFLARE_AI_GATEWAY_URL }
        : {}),
      ...(env.GEMINI_API_KEY ? { geminiApiKey: env.GEMINI_API_KEY } : {}),
    });
    console.log(
      env.GEMINI_API_KEY
        ? "image gen: Cloudflare FLUX.1-schnell + Gemini fallback"
        : "image gen: Cloudflare Workers AI FLUX.1-schnell",
    );
  } else if (env.GEMINI_API_KEY) {
    setCloudflareImageConfig({ geminiApiKey: env.GEMINI_API_KEY });
    console.log("image gen: Gemini only (no Cloudflare)");
  } else {
    console.warn(
      "CLOUDFLARE_* / GEMINI_API_KEY missing — image gen disabled",
    );
  }

  // Both persona bots share one StyleStore — /m|/с|/m2|/с2 train both.
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
  console.log(
    `LLM ready: ${llm.model} [${providers.join(" → ")}] (fast: groq→gemini→openrouter)`,
  );
  const runTrain = async (reason: string) => {
    try {
      const profile = await twins.alpha.learnFromSharedCorpus();
      if (profile) {
        await twins.beta.loadSharedProfile();
        console.log(
          `style distilled (${reason}): samples=${profile.sampleCount} at ${profile.updatedAt}`,
        );
      } else {
        console.log(
          `style train skipped (${reason}): no anon (/m|/с|/m2|/с2) samples yet`,
        );
      }
    } catch (error) {
      console.warn(`style train failed (${reason})`, error);
    }
  };

  void runTrain("startup");
  setInterval(() => {
    void runTrain("interval");
  }, TRAIN_INTERVAL_MS);

  // Alpha = first bot (/m /с). Beta = second bot (/m2 /с2) when token set.
  const twinMode = { enabled: false };
  const alphaBot = createBot(env.TELEGRAM_BOT_TOKEN, {
    twins,
    personaId: "alpha",
    commandSuffix: "",
    twinMode,
  });

  const betaBot = env.TELEGRAM_BOT_TOKEN_2
    ? createBot(env.TELEGRAM_BOT_TOKEN_2, {
        twins,
        personaId: "beta",
        commandSuffix: "2",
        twinMode,
      })
    : undefined;

  const webhookBots: WebhookBot[] = [{ bot: alphaBot, key: "alpha" }];
  if (betaBot) {
    webhookBots.push({ bot: betaBot, key: "beta" });
  }

  if (env.publicBaseUrl) {
    startWebhookServer(webhookBots, env);
  }

  const alphaUser = await bootBot(alphaBot, "bot[alpha]", [
    { command: "start", description: "How this bot works" },
    { command: "help", description: "Usage for /m and /с" },
    { command: "m", description: "Send an anonymous message" },
  ]);
  if (!alphaUser && env.publicBaseUrl) {
    // Keep HTTP /health up so Render does not kill the service on a bad token.
  } else if (!alphaUser) {
    throw new Error("TELEGRAM_BOT_TOKEN is invalid");
  }

  let betaUser: string | undefined;
  if (betaBot) {
    betaUser = await bootBot(betaBot, "bot[beta]", [
      { command: "start", description: "How goscha2 works" },
      { command: "help", description: "Usage for /m2 and /с2" },
      { command: "m2", description: "Send an anonymous message (bot 2)" },
    ]);
    if (betaUser) {
      twinMode.enabled = true;
      console.log("twin mode on: Гоша mentions split even→alpha / odd→beta");
    } else {
      console.warn(
        "TELEGRAM_BOT_TOKEN_2 invalid — running with first bot only",
      );
    }
  } else {
    console.log(
      "TELEGRAM_BOT_TOKEN_2 unset — second persona bot disabled (/m2 /с2 unavailable)",
    );
  }

  const chatterBots = [
    chatterFromBot(alphaBot, "alpha", alphaUser ? `@${alphaUser}` : "alpha"),
  ];
  if (betaBot && betaUser) {
    chatterBots.push(
      chatterFromBot(betaBot, "beta", `@${betaUser}`),
    );
  }
  startProactiveChatter(chatterBots, twins);

  if (env.publicBaseUrl) {
    try {
      const webhookUrl = await registerWebhook(alphaBot, env, "alpha");
      console.log(`webhook alpha set: ${webhookUrl}`);
      if (betaBot && betaUser) {
        const webhookUrl2 = await registerWebhook(betaBot, env, "beta");
        console.log(`webhook beta set: ${webhookUrl2}`);
      }
      startKeepAlive(env.publicBaseUrl);
    } catch (error) {
      console.error("setWebhook failed", error);
    }
    return;
  }

  console.log("no public URL — starting long polling (local/dev)");
  await alphaBot.api.deleteWebhook({ drop_pending_updates: true });
  if (betaBot && betaUser) {
    await betaBot.api.deleteWebhook({ drop_pending_updates: true });
  }

  const starters: Promise<void>[] = [
    alphaBot.start({
      onStart: () => console.log("polling alpha started"),
    }),
  ];
  if (betaBot && betaUser) {
    starters.push(
      betaBot.start({
        onStart: () => console.log("polling beta started"),
      }),
    );
  }
  await Promise.all(starters);
}

main().catch((error) => {
  console.error("fatal", error);
  process.exit(1);
});

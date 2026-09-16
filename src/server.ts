import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { webhookCallback, type Bot } from "grammy";

import type { Env } from "./env.js";

function webhookPath(secret: string, botKey: "alpha" | "beta" = "alpha"): string {
  if (botKey === "beta") {
    return `/telegram/webhook2/${secret}`;
  }
  return `/telegram/webhook/${secret}`;
}

export type WebhookBot = {
  bot: Bot;
  key: "alpha" | "beta";
};

export function startWebhookServer(bots: WebhookBot[], env: Env): void {
  const routes = bots.map((entry) => ({
    path: webhookPath(env.WEBHOOK_SECRET, entry.key),
    handleUpdate: webhookCallback(entry.bot, "http"),
    key: entry.key,
  }));

  const server = createServer((req, res) => {
    void route(req, res, routes);
  });

  server.listen(env.PORT, "0.0.0.0", () => {
    console.log(`listening on 0.0.0.0:${env.PORT}`);
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Array<{
    path: string;
    handleUpdate: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<void> | void;
    key: string;
  }>,
): Promise<void> {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && req.url) {
      const match = routes.find((r) => req.url === r.path);
      if (match) {
        await match.handleUpdate(req, res);
        return;
      }
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (error) {
    console.error("http handler error", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("error");
  }
}

export async function registerWebhook(
  bot: Bot,
  env: Env,
  botKey: "alpha" | "beta" = "alpha",
): Promise<string> {
  if (!env.publicBaseUrl) {
    throw new Error(
      "WEBHOOK_URL or RENDER_EXTERNAL_URL is required in webhook mode",
    );
  }

  const url = `${env.publicBaseUrl.replace(/\/$/, "")}${webhookPath(env.WEBHOOK_SECRET, botKey)}`;
  await bot.api.setWebhook(url, {
    allowed_updates: ["message"],
    // Never drop pending on boot - free Render cold starts otherwise eat group /m updates.
    drop_pending_updates: false,
  });
  return url;
}

/**
 * Ping /health so free Render does not sleep after 15m idle.
 * Without this, the first group /m after idle often fails until a DM wakes the service.
 */
export function startKeepAlive(publicBaseUrl: string): void {
  const healthUrl = `${publicBaseUrl.replace(/\/$/, "")}/health`;
  const intervalMs = 10 * 60 * 1000;

  const ping = async () => {
    try {
      const res = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`keep-alive ${res.status} from ${healthUrl}`);
      }
    } catch (error) {
      console.warn("keep-alive failed", error);
    }
  };

  console.log(`keep-alive every 10m -> ${healthUrl}`);
  void ping();
  setInterval(() => {
    void ping();
  }, intervalMs);
}

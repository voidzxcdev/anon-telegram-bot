import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { webhookCallback, type Bot } from "grammy";

import type { Env } from "./env.js";

function webhookPath(secret: string): string {
  return `/telegram/webhook/${secret}`;
}

export function startWebhookServer(bot: Bot, env: Env): void {
  const path = webhookPath(env.WEBHOOK_SECRET);
  const handleUpdate = webhookCallback(bot, "http");

  const server = createServer((req, res) => {
    void route(req, res, handleUpdate, path);
  });

  server.listen(env.PORT, "0.0.0.0", () => {
    console.log(`listening on 0.0.0.0:${env.PORT}`);
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  handleUpdate: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  path: string,
): Promise<void> {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && req.url === path) {
      await handleUpdate(req, res);
      return;
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

export async function registerWebhook(bot: Bot, env: Env): Promise<string> {
  if (!env.publicBaseUrl) {
    throw new Error(
      "WEBHOOK_URL or RENDER_EXTERNAL_URL is required in webhook mode",
    );
  }

  const url = `${env.publicBaseUrl.replace(/\/$/, "")}${webhookPath(env.WEBHOOK_SECRET)}`;
  await bot.api.setWebhook(url, {
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  return url;
}

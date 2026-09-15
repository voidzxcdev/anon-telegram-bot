export interface Env {
  AI: Ai;
  PROXY_SECRET: string;
}

/** Free Workers AI model — stays within 10k Neurons/day. */
const MODEL = "@cf/black-forest-labs/flux-1-schnell";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { success: false, errors: [{ message: "POST only" }] },
        { status: 405 },
      );
    }

    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.PROXY_SECRET || token !== env.PROXY_SECRET) {
      return Response.json(
        { success: false, errors: [{ message: "Unauthorized" }] },
        { status: 401 },
      );
    }

    try {
      const body = (await request.json()) as {
        prompt?: string;
        num_steps?: number;
      };
      const prompt = String(body.prompt || "").trim();
      if (!prompt) {
        return Response.json(
          { success: false, errors: [{ message: "prompt required" }] },
          { status: 400 },
        );
      }

      const result = await env.AI.run(MODEL, {
        prompt,
      });

      return Response.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        /4006|neurons|daily free allocation/i.test(message) ? 429 : 500;
      return Response.json(
        { success: false, errors: [{ message }] },
        { status },
      );
    }
  },
};

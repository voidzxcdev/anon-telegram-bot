export interface Env {
  AI: Ai;
  PROXY_SECRET: string;
}

const MODEL = "@cf/black-forest-labs/flux-2-dev";

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

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data") || !request.body) {
      return Response.json(
        {
          success: false,
          errors: [{ message: "multipart/form-data body required" }],
        },
        { status: 400 },
      );
    }

    try {
      // Forward raw multipart stream — FLUX.2-dev requires multipart input.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (env.AI as any).run(MODEL, {
        multipart: {
          body: request.body,
          contentType,
        },
      });

      return Response.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(
        { success: false, errors: [{ message }] },
        { status: 500 },
      );
    }
  },
};

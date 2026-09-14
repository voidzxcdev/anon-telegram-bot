import OpenAI from "openai";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_FREE_MODEL = "muse-spark-1.3-contributor-free";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenCodeClient = {
  model: string;
  complete: (messages: ChatMessage[]) => Promise<string>;
};

/**
 * OpenCode Zen free endpoint (Muse Spark 1.3 Contributor Free).
 * Uses the OpenAI-compatible Responses API at /v1/responses.
 *
 * Privacy: Contributor Free allows Meta to use prompts/completions for training.
 * Limited-time free tier per OpenCode Zen docs — not guaranteed forever.
 */
export function createOpenCodeClient(
  apiKey: string,
  options: { model?: string; baseURL?: string } = {},
): OpenCodeClient {
  const model = options.model ?? OPENCODE_FREE_MODEL;
  const client = new OpenAI({
    apiKey,
    baseURL: options.baseURL ?? OPENCODE_ZEN_BASE_URL,
  });

  return {
    model,
    async complete(messages: ChatMessage[]): Promise<string> {
      const response = await client.responses.create({
        model,
        input: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      const text = response.output_text?.trim();
      if (text) {
        return text;
      }

      // Fallback if output_text is empty but structured output exists
      const chunks: string[] = [];
      for (const item of response.output ?? []) {
        if (item.type !== "message") {
          continue;
        }
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) {
            chunks.push(part.text);
          }
        }
      }

      const joined = chunks.join("\n").trim();
      if (!joined) {
        throw new Error("OpenCode returned an empty response");
      }
      return joined;
    },
  };
}

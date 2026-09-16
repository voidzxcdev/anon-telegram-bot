import type { LlmClient } from "../llm/types.js";
import { DASH_RULE } from "../llm/types.js";
import { goshaSystemRules } from "./gosha.js";
import { extractImagePrompt } from "./image-gen.js";
import {
  getSharedStyleStore,
  type StyleProfile,
  type StyleStore,
} from "./store.js";
import { distillSharedStyleProfile } from "./train.js";

export type PersonaId = "alpha" | "beta";

/**
 * Two persona bots that always share one StyleStore + one StyleProfile.
 * Using Telegram /m or /с on a single bot still trains both learners.
 */
export class PersonaBot {
  readonly id: PersonaId;
  private readonly store: StyleStore;
  private readonly llm: LlmClient | undefined;
  private cachedProfile: StyleProfile | undefined;

  constructor(
    id: PersonaId,
    options: { store?: StyleStore; llm?: LlmClient } = {},
  ) {
    this.id = id;
    this.store = options.store ?? getSharedStyleStore();
    this.llm = options.llm;
  }

  async loadSharedProfile(): Promise<StyleProfile | undefined> {
    this.cachedProfile = await this.store.readProfile();
    return this.cachedProfile;
  }

  getProfile(): StyleProfile | undefined {
    return this.cachedProfile;
  }

  async learnFromSharedCorpus(): Promise<StyleProfile | undefined> {
    if (!this.llm) {
      throw new Error("LLM API key required to distill style");
    }
    const profile = await distillSharedStyleProfile(this.llm, this.store);
    this.cachedProfile = profile;
    return profile;
  }

  async speak(topic: string): Promise<string> {
    if (!this.llm) {
      throw new Error("LLM API key required");
    }
    const profile = this.cachedProfile ?? (await this.loadSharedProfile());
    const card =
      profile?.card ??
      "No style card yet - mimic casual bilingual chat briefly.";

    return this.llm.complete([
      {
        role: "system",
        content:
          `You are persona bot "${this.id}". Speak ONLY in the user's learned style.\n` +
          `${DASH_RULE}\n` +
          `Shared style card:\n${card}`,
      },
      { role: "user", content: topic },
    ]);
  }

  async speakAsGosha(
    userMessage: string,
    styleCard: string,
    fromHandle?: string,
    /** Last ~50 group messages from everyone (all members + prior Гоша). */
    groupContext?: string,
  ): Promise<string> {
    if (!this.llm) {
      throw new Error("LLM API key required");
    }
    const who = fromHandle ? `Triggered by: ${fromHandle}\n` : "";
    const contextBlock = groupContext?.trim()
      ? `Recent group chat (last messages from everyone, oldest→newest):\n${groupContext.trim()}\n\n`
      : "";
    return this.llm.complete(
      [
        {
          role: "system",
          content: goshaSystemRules(styleCard, this.id),
        },
        {
          role: "user",
          content:
            `${who}${contextBlock}` +
            `Someone mentioned you (Гоша). Reply once as a normal guy in the chat.\n` +
            `Answer straight. Keep it tiny (one short line). Playful is OK; cryptic/witty-dodge is not.\n` +
            `No coach/lifehack energy. @ them if it fits.\n\n` +
            `Latest message:\n${userMessage}`,
        },
      ],
      { maxTokens: 60 },
    );
  }

  /**
   * Unsolicited group chatter — react to recent context, stay short.
   */
  async speakProactive(
    styleCard: string,
    groupContext: string,
  ): Promise<string> {
    if (!this.llm) {
      throw new Error("LLM API key required");
    }
    const contextBlock = groupContext.trim()
      ? `Recent group chat (oldest→newest):\n${groupContext.trim()}\n\n`
      : "";
    return this.llm.complete(
      [
        {
          role: "system",
          content: goshaSystemRules(styleCard, this.id),
        },
        {
          role: "user",
          content:
            `${contextBlock}` +
            `Nobody pinged you. Drop one short casual line into the group about something from the recent chat ` +
            `(or a light throwaway if the chat is quiet). Normal guy energy. No questions essay. No \"привет всем\". ` +
            `One short line only.`,
        },
      ],
      { maxTokens: 60 },
    );
  }

  /** Strip Гоша / draw verbs; use the subject verbatim (no LLM enhance). */
  makeImagePrompt(userMessage: string): string {
    return extractImagePrompt(userMessage);
  }
}

export type TwinLearners = {
  alpha: PersonaBot;
  beta: PersonaBot;
  store: StyleStore;
};

export function createTwinLearners(llm?: LlmClient): TwinLearners {
  const store = getSharedStyleStore();
  const shared = llm ? { store, llm } : { store };
  return {
    store,
    alpha: new PersonaBot("alpha", shared),
    beta: new PersonaBot("beta", shared),
  };
}

import type { LlmClient } from "../llm/types.js";
import { DASH_RULE } from "../llm/types.js";
import { goshaSystemRules } from "./gosha.js";
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

  async speakAsGosha(userMessage: string, styleCard: string): Promise<string> {
    if (!this.llm) {
      throw new Error("LLM API key required");
    }
    return this.llm.complete([
      {
        role: "system",
        content: goshaSystemRules(styleCard, this.id),
      },
      {
        role: "user",
        content:
          "Someone mentioned you (Гоша) in this chat message. Answer as Гоша with one short normal message. No intro, no @names, no lifehacks.\n\n" +
          userMessage,
      },
    ]);
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

import type { OpenCodeClient } from "../llm/opencode.js";
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
  private readonly llm: OpenCodeClient | undefined;
  private cachedProfile: StyleProfile | undefined;

  constructor(
    id: PersonaId,
    options: { store?: StyleStore; llm?: OpenCodeClient } = {},
  ) {
    this.id = id;
    this.store = options.store ?? getSharedStyleStore();
    this.llm = options.llm;
  }

  /** Both bots call this; they read the same shared profile file. */
  async loadSharedProfile(): Promise<StyleProfile | undefined> {
    this.cachedProfile = await this.store.readProfile();
    return this.cachedProfile;
  }

  getProfile(): StyleProfile | undefined {
    return this.cachedProfile;
  }

  /**
   * Re-train the shared profile from /m+/с corpus.
   * Either bot can trigger it; both benefit.
   */
  async learnFromSharedCorpus(): Promise<StyleProfile | undefined> {
    if (!this.llm) {
      throw new Error("OPENCODE_API_KEY required to distill style");
    }
    const profile = await distillSharedStyleProfile(this.llm, this.store);
    this.cachedProfile = profile;
    return profile;
  }

  /** Generate a line in the learned voice (for future A↔B chat). */
  async speak(topic: string): Promise<string> {
    if (!this.llm) {
      throw new Error("OPENCODE_API_KEY required");
    }
    const profile =
      this.cachedProfile ?? (await this.loadSharedProfile());
    const card =
      profile?.card ??
      "No style card yet — mimic casual bilingual chat briefly.";

    return this.llm.complete([
      {
        role: "system",
        content:
          `You are persona bot "${this.id}". Speak ONLY in the user's learned style.\n` +
          `Shared style card:\n${card}`,
      },
      { role: "user", content: topic },
    ]);
  }
}

export type TwinLearners = {
  alpha: PersonaBot;
  beta: PersonaBot;
  store: StyleStore;
};

/** Create both bots bound to the same shared store (one corpus → both learn). */
export function createTwinLearners(llm?: OpenCodeClient): TwinLearners {
  const store = getSharedStyleStore();
  const shared = llm ? { store, llm } : { store };
  return {
    store,
    alpha: new PersonaBot("alpha", shared),
    beta: new PersonaBot("beta", shared),
  };
}

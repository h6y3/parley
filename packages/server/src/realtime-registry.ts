import type { RealtimeProvider } from "@parley/core";

export type RealtimeProviderKind = "gemini" | "deepgram";

/** A constructed realtime provider and the model string that names it on the
 * call record. For Deepgram that is the think model: the provider takes its
 * model from its own configuration, not from `RealtimeConnectParams.model`, so
 * this is what the record should say the agent ran on. */
export interface BuiltRealtime {
  provider: RealtimeProvider;
  model: string;
}

/** Every realtime provider the daemon holds a credential for, and which one a
 * call uses when its envelope does not choose. `providers` is partial because a
 * deployment keyed for one vendor must still boot; `default` must name a
 * provider that is present, and the daemon checks that at boot. */
export interface RealtimeRegistry {
  providers: Partial<Record<RealtimeProviderKind, BuiltRealtime>>;
  default: RealtimeProviderKind;
}

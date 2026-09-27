export const PACKAGE_NAME = "@parley/realtime-deepgram";

export {
  createDeepgramRealtimeProvider,
  DEEPGRAM_AGENT_URL,
  DEFAULT_DEEPGRAM_LLM_MODEL,
  DEFAULT_DEEPGRAM_VOICE
} from "./deepgram-realtime-provider.js";
export type {
  AgentSocket,
  DeepgramRealtimeProviderOptions,
  WsFactory
} from "./deepgram-realtime-provider.js";

export const PACKAGE_NAME = "@parley/realtime-deepgram";

export {
  buildDeepgramSettings,
  createDeepgramRealtimeProvider,
  DEEPGRAM_AGENT_URL,
  DEEPGRAM_AUDIO_ENCODING,
  DEEPGRAM_SPEED_MAX,
  DEEPGRAM_SPEED_MIN,
  DEEPGRAM_THINK_MODELS,
  DEEPGRAM_VOICES,
  DEFAULT_DEEPGRAM_LISTEN_MODEL,
  DEFAULT_DEEPGRAM_SPEED,
  DEFAULT_DEEPGRAM_THINK,
  DEFAULT_DEEPGRAM_VOICE,
  defaultWsFactory
} from "./deepgram-realtime-provider.js";
export { createDeepgramTurnCompletion, DEEPGRAM_TURN_QUIET_MS } from "./turn-completion.js";
export type { DeepgramTurnCompletion } from "./turn-completion.js";
export type {
  AgentSocket,
  DeepgramFunctionDeclaration,
  DeepgramRealtimeProviderOptions,
  DeepgramSettings,
  ResolvedDeepgramOptions,
  WsFactory
} from "./deepgram-realtime-provider.js";

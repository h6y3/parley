export const PACKAGE_NAME = "@parley/transcription-deepgram";
export {
  createDeepgramTranscriptionProvider,
  DEEPGRAM_DEFAULT_MODEL,
  FLUSH_RESULT_TIMEOUT_MS
} from "./deepgram-transcription-provider.js";
export type { TranscriptionSocket, WsFactory } from "./deepgram-transcription-provider.js";

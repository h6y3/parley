import type { AudioEncoding, AudioFrame, AudioSource, TranscriptEvent } from "./types.js";

/** Marker export, asserted by transcription-contract.test.ts.
 *
 * The listening plane's guarantee is that no reference to an outbound audio
 * sink exists on it — the compiler enforces silence, and no runtime test is
 * asked to prove a negative. This constant is the anchor that makes the
 * intent greppable. */
export const TRANSCRIPTION_PLANE_HAS_NO_OUTBOUND = true as const;

export interface TranscriptionProviderError {
  code: string;
  message: string;
  fatal: boolean;
}

export interface TranscriptionCallbacks {
  onTranscript: (event: TranscriptEvent) => void;
  onError: (error: TranscriptionProviderError) => void;
  onClose: (reason: string) => void;
}

export interface TranscriptionConnectParams {
  encoding: AudioEncoding;
  channels: number;
  interimResults: boolean;
  wordTimestamps: boolean;
  diarize: boolean;
  /** Meeting-relative offset added to every emitted timestamp.
   *
   * A reconnect is a NEW upstream stream starting at t=0. Without carrying the
   * offset across, every reconnect resets word timestamps and any downstream
   * claim of "traceable to a point in the transcript" silently becomes false.
   * There is no resume, and this interface deliberately does not model one. */
  offsetMs: number;
  callbacks: TranscriptionCallbacks;
}

export interface TranscriptionSession {
  /** False when the session cannot currently accept audio. The session DROPS
   * frames rather than buffering them: a carrier delivers 50 frames a second
   * regardless of our state, so buffering produces an unbounded queue and then
   * a flood, and a transcript that arrives minutes late is worse than one with
   * a recorded hole. The caller records the drop as a gap.
   *
   * **NOTHING IN SLICE A RECONNECTS, and this field's earlier wording ("false
   * while reconnecting") described behaviour that does not exist.** The
   * interface deliberately models no resume (see `offsetMs` below), no shipped
   * provider retries, and `CallSession` treats `onClose` as terminal: it ends
   * the call as `transcriptionLost` rather than attempting to come back,
   * because after the consent handoff taking notes is the call's only
   * remaining purpose and sitting on a live, billing call that is no longer
   * taking any is the one outcome that must not happen.
   *
   * Two consequences a reader downstream has to know, because they are not
   * visible from the artifacts:
   *
   *  - a `transcriber_not_ready` gap is effectively unreachable in production.
   *    The only window in which it can open is the few frames between a socket
   *    close setting `ready` false and `endCall` clearing the sinks. The gap a
   *    real meeting does record is `transcriber_connecting`, the handoff
   *    window;
   *  - so `gapMs` on a real meeting record is small — the connect window and
   *    nothing else — and a consumer's "degrade if more than N% of the meeting
   *    is missing" rule will effectively never fire in slice A. What DOES
   *    happen when the transcriber is lost is that the call ends, which the
   *    record says: `endedReason: "transcription_lost"`. That is the field to
   *    branch on, not `gapMs`. */
  readonly ready: boolean;
  sendAudio(frame: AudioFrame, source?: AudioSource): void;
  /** Emit any pending partial as final. Without it the last utterance of a
   * meeting is lost when the session closes. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface TranscriptionProvider {
  readonly name: string;
  /** What this provider consumes. A captions-only provider — a native meeting
   * API that pushes text and takes no audio — sets `audio: false`, and the
   * session then never pumps frames at it. */
  readonly ingress: { audio: boolean; channels: "mono" | "multi" };
  /** Encodings accepted, most preferred first. AudioBridge converts to
   * `accepts[0]` when the source produces none of them. */
  readonly accepts: readonly AudioEncoding[];
  connect(params: TranscriptionConnectParams): Promise<TranscriptionSession>;
}

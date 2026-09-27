import type {
  AudioFrame,
  TranscriptEvent,
  TranscriptWord,
  TranscriptionConnectParams,
  TranscriptionProvider,
  TranscriptionSession
} from "@parley/core";
import { MULAW_8K, PCM_16K } from "@parley/core";
import WebSocket from "ws";

export const DEEPGRAM_DEFAULT_MODEL = "nova-3";

/** Ceiling on waiting for the `Results` message `Finalize` asks for.
 *
 * Short, because this sits on the hangup path: `CallSession.endCall` flushes
 * the listening plane before closing the media handle, and every millisecond
 * here is a millisecond of a call that is already over. Long enough that a
 * vendor round-trip on a live socket lands inside it. It bounds an answer that
 * never arrives, and must never be the thing being waited for. Exported so a
 * test can wait exactly this long rather than guessing. */
export const FLUSH_RESULT_TIMEOUT_MS = 2_000;

export interface TranscriptionSocket {
  on(event: "open" | "message" | "close" | "error", fn: (...args: never[]) => void): void;
  send(data: Buffer | string): void;
  close(): void;
}

export type WsFactory = (url: string, headers: Record<string, string>) => TranscriptionSocket;

const encodingQuery = (params: TranscriptionConnectParams): string => {
  if (params.encoding.codec === "mulaw")
    return `encoding=mulaw&sample_rate=${params.encoding.sampleRate}`;
  return `encoding=linear16&sample_rate=${params.encoding.sampleRate}`;
};

/** Deepgram reports segment timings in SECONDS relative to the stream it is
 * currently carrying. Two facts follow, and both are load-bearing:
 *
 * 1. Interim results for one segment repeat the same `start`, so `start` is a
 *    stable identity for that segment across its revisions — which is exactly
 *    what TranscriptEvent.segmentId means. Without it the aggregator appends
 *    growing prefixes and produces "thethe quickthe quick brown".
 * 2. A reconnect is a NEW stream whose clock restarts at zero, so every
 *    timestamp is offset by the meeting-relative `offsetMs` the caller passes.
 *    The segmentId is derived AFTER the offset, so ids stay unique across a
 *    reconnect too. */
const toEvent = (payload: DeepgramResults, offsetMs: number): TranscriptEvent | undefined => {
  const alt = payload.channel?.alternatives?.[0];
  const text = alt?.transcript ?? "";
  if (text === "") return undefined;
  const startMs = Math.round(payload.start * 1000) + offsetMs;
  const endMs = startMs + Math.round((payload.duration ?? 0) * 1000);
  const words: TranscriptWord[] = (alt?.words ?? []).map((w) => ({
    text: w.word,
    startMs: Math.round(w.start * 1000) + offsetMs,
    endMs: Math.round(w.end * 1000) + offsetMs,
    ...(w.confidence === undefined ? {} : { confidence: w.confidence })
  }));
  return {
    speaker: "participant",
    // No speakerId: slice A does not diarize, and an absent id means
    // "unattributed" rather than "attributed to nobody".
    segmentId: String(startMs),
    startMs,
    endMs,
    ...(words.length > 0 ? { words } : {}),
    text,
    isFinal: payload.is_final === true
  };
};

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}
interface DeepgramResults {
  type?: string;
  start: number;
  duration?: number;
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: DeepgramWord[] }[] };
}

export function createDeepgramTranscriptionProvider(opts: {
  apiKey: string;
  model?: string;
  wsFactory?: WsFactory;
}): TranscriptionProvider {
  const model = opts.model ?? DEEPGRAM_DEFAULT_MODEL;
  const factory: WsFactory =
    opts.wsFactory ??
    ((url, headers) => new WebSocket(url, { headers }) as unknown as TranscriptionSocket);

  return {
    name: "deepgram",
    ingress: { audio: true, channels: "mono" },
    // mulaw@8000 first: a PSTN leg already produces it, so AudioBridge records
    // a pass-through rather than a conversion.
    accepts: [MULAW_8K, PCM_16K],
    async connect(params: TranscriptionConnectParams): Promise<TranscriptionSession> {
      // UNVERIFIED, needs confirming against the live Deepgram API before
      // Task 12 wires this provider into a real call. params.wordTimestamps
      // is not threaded into the query string below because the expectation
      // is that Deepgram's Listen API returns per-word timing
      // unconditionally in each alternative's `words` array, with no
      // request-side toggle that gates it (unlike opt-in flags such as
      // `punctuate` or `diarize`). That is a belief, not a checked fact: it
      // is recalled from training data, not read from documentation and not
      // confirmed by a live call — this task makes none, deliberately (see
      // the wsFactory injection point). If the recollection is wrong,
      // wordTimestamps is silently inert as written: a caller setting it to
      // false still gets word timings, and one setting it to true has no
      // way to know whether it did anything.
      const query = [
        `model=${encodeURIComponent(model)}`,
        encodingQuery(params),
        `channels=${params.channels}`,
        `interim_results=${params.interimResults}`,
        `punctuate=true`,
        `diarize=${params.diarize}`
      ].join("&");

      let socket: TranscriptionSocket;
      try {
        // The key travels in a header and never in the URL — a URL reaches
        // logs, proxies and error messages; a header does not.
        socket = factory(`wss://api.deepgram.com/v1/listen?${query}`, {
          Authorization: `Token ${opts.apiKey}`
        });
      } catch {
        // Deliberately does NOT re-raise the underlying error: it may quote the
        // request, and the request carries the credential.
        throw new Error("deepgram: could not open transcription socket");
      }

      let ready = false;
      let closed = false;

      await new Promise<void>((resolve, reject) => {
        socket.on("open", (() => {
          ready = true;
          resolve();
        }) as never);
        socket.on("error", ((err: Error) => {
          params.callbacks.onError({
            code: "socket_error",
            message: err?.message ?? "unknown",
            fatal: !ready
          });
          if (!ready) reject(new Error("deepgram: transcription socket failed to open"));
        }) as never);
      });

      /** A `flush()` waiting for the `Results` that `Finalize` asks for. */
      let pendingFlush: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
      const settleFlush = (): void => {
        const flush = pendingFlush;
        if (!flush) return;
        pendingFlush = undefined;
        clearTimeout(flush.timer);
        flush.resolve();
      };

      socket.on("message", ((raw: Buffer) => {
        let payload: DeepgramResults;
        try {
          payload = JSON.parse(raw.toString()) as DeepgramResults;
        } catch {
          return;
        }
        if (payload.type !== undefined && payload.type !== "Results") return;
        const event = toEvent(payload, params.offsetMs);
        if (event) params.callbacks.onTranscript(event);
        // AFTER the event is delivered, never before: a flush that resolved
        // first would let the hangup proceed past the very utterance it was
        // waiting for. And gated on is_final: `interimResults: true` means an
        // interim can already be in flight when Finalize is sent, and it
        // arrives as its own `Results` message with non-empty text — settling
        // on that one releases the waiter before the finalized last utterance
        // (its own, later, message) ever shows up.
        if (payload.is_final === true) settleFlush();
      }) as never);

      socket.on("close", ((_code: number, reason: Buffer) => {
        ready = false;
        closed = true;
        // A closed socket can never answer a Finalize. Release the waiter
        // rather than hold the hangup open for the full timeout.
        settleFlush();
        params.callbacks.onClose(reason?.toString() ?? "closed");
      }) as never);

      return {
        get ready() {
          return ready;
        },
        sendAudio(frame: AudioFrame): void {
          // Drop, never buffer. A carrier delivers 50 frames a second whatever
          // our state is; buffering a reconnect produces an unbounded queue and
          // then a flood, and the caller has already recorded the hole.
          if (!ready) return;
          socket.send(frame.data);
        },
        async flush(): Promise<void> {
          if (!ready) return;
          // Deepgram's documented end-of-stream marker. Without it the final
          // partial is never promoted and the meeting's last utterance is lost.
          socket.send(JSON.stringify({ type: "Finalize" }));
          // And then WAIT for the answer. Resolving as soon as the marker was
          // written to a socket resolves on "the request was sent", not on
          // "the last utterance arrived" — so the caller's whole reason for
          // flushing (`CallSession.endCall` flushes before it closes anything,
          // so the meeting's last words land in the transcript) was defeated
          // by an await that never awaited the vendor. Bounded, because a
          // vendor that never answers must not hold a finished call open.
          settleFlush();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              pendingFlush = undefined;
              resolve();
            }, FLUSH_RESULT_TIMEOUT_MS);
            pendingFlush = { resolve, timer };
          });
        },
        async close(): Promise<void> {
          if (closed) return;
          socket.send(JSON.stringify({ type: "CloseStream" }));
          socket.close();
        }
      };
    }
  };
}

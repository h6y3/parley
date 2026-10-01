import {
  encodingEquals,
  formatEncoding,
  MEETING_CONNECTED_CUE,
  MULAW_8K,
  type AudioEncoding,
  type AudioFrame,
  type RealtimeConnectParams,
  type RealtimeProvider,
  type RealtimeSession,
  type SpeakerRole,
  type ToolCallRequest,
  type ToolResult
} from "@parley/core";
import WebSocket from "ws";
import { createDeepgramTurnCompletion } from "./turn-completion.js";

/** Verified against Deepgram's public Voice Agent docs on 2026-08-19 and
 * again on 2026-09-29 (`v1/agent/converse` is current). Regional variants
 * exist (`api.eu.deepgram.com`, `api.au.deepgram.com`) but are out of scope.
 * One exported constant so this has exactly one place to be wrong. */
export const DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";

/** The carrier's own encoding, both ways. One constant feeds BOTH the
 * provider's declared `audio` and the `Settings` message, so what Parley
 * bridges and what Deepgram is told to expect cannot disagree. */
export const DEEPGRAM_AUDIO_ENCODING: AudioEncoding = MULAW_8K;

/** The `agent.think` provider. `open_ai` is one of Deepgram's MANAGED think
 * providers: it needs no endpoint and no separate vendor key, only the
 * Deepgram key already on the connection. `gpt-4o-mini` is the model
 * Deepgram's own telephony reference agents use, it sits in the Standard
 * pricing tier ($0.075 a minute against $0.163 for the Advanced tier that
 * claude-sonnet-4-6 bills at), and with the production prompt it measured
 * about 0.5 to 0.96 s from callee text to first audio against about 1.15 to
 * 1.77 s for claude-sonnet-4-6. Known gap, measured on an earlier default and
 * not re-measured here: a model can speak after the meeting-connected cue, so
 * meetings belong on the Gemini provider until that is checked. */
export const DEFAULT_DEEPGRAM_THINK: { readonly provider: string; readonly model: string } = {
  provider: "open_ai",
  model: "gpt-4o-mini"
};

/** Flux, Deepgram's conversational listener: it does its own end-of-turn
 * detection, which is what the Voice Agent's turn-taking runs on. Left at the
 * default `eot_threshold` and with no eager end-of-turn — an eager turn can
 * fire a tool call the caller has not finished asking for, and ToolGate's
 * effects are not reversible. */
export const DEFAULT_DEEPGRAM_LISTEN_MODEL = "flux-general-en";

/** The default Flux voice (Kelsey), rendered mulaw@8000 natively. Kit was tried
 * for its pace but, at the speed the live calls needed, its accent was hard to
 * understand. Overridable per provider (`opts.voice`) or per connect
 * (`RealtimeConnectParams.voice`). */
export const DEFAULT_DEEPGRAM_VOICE = "flux-kelsey-en";

/** Speak pace multiplier. Deepgram's agent TTS defaults to about 119 words
 * a minute (measured: a 29-word reply took 14.6 s at speed 1.0), which sounded
 * far too slow on a live call. It accepts `agent.speak.provider.speed` in
 * 0.7 to 1.5; 1.25 was chosen by ear on live calls: 1.4 and 1.45 sounded too
 * fast over a whole conversation, though fine for a sentence. */
export const DEFAULT_DEEPGRAM_SPEED = 1.25;
/** The speak speed range Deepgram accepts. */
export const DEEPGRAM_SPEED_MIN = 0.7;
export const DEEPGRAM_SPEED_MAX = 1.5;

/** Deepgram closes an agent socket that goes quiet; its docs ask for a
 * KeepAlive every 8 s when no audio flows. The carrier normally streams
 * continuously, so this only covers a stall. */
/** The single numeric field a LatencyReport carries, one of these per message. */
const LATENCY_FIELDS = [
  "ttt_token_latency",
  "ttt_text_latency",
  "tts_latency",
  "total_latency",
  "ttt_tool_latency"
] as const;
const KEEPALIVE_INTERVAL_MS = 8000;

const DEFAULT_SETTINGS_TIMEOUT_MS = 10_000;

/** `sendOpeningTrigger` becomes an `InjectUserMessage`: a user turn the LLM
 * hears as the callee speaking. Sent Parley's long opening triggers that way,
 * models hung up during the ring or said "I'm listening and waiting for the
 * other end to speak" aloud — so this provider declares
 * `openingDelivery: "prompt"`, the triggers ride in the Settings prompt, and
 * the only line `planOpening` ever sends here is `MEETING_CONNECTED_CUE`.
 *
 * It is still the only privileged input besides the one-shot Settings prompt,
 * so it stays one short bounded line — never a mid-session re-instruction
 * path, and never the long triggers, which this bound now refuses. DERIVED
 * from the cue with headroom for its wording to grow: a hard-coded number is
 * how the August spike's 120-character cap came to reject the real trigger. */
const OPENING_TRIGGER_MAX_CHARS = 2 * MEETING_CONNECTED_CUE.length;
const OPENING_TRIGGER_REJECTED =
  "sendOpeningTrigger accepts only one short opening cue — no newline, and no longer than " +
  "twice Parley's meeting cue. On this provider Parley's opening belongs in the Settings " +
  "prompt, and this must never become a mid-session re-instruction path.";

export interface AgentSocket {
  on(event: "open" | "message" | "close" | "error", fn: (...args: never[]) => void): void;
  send(data: Buffer | string): void;
  close(): void;
}

export type WsFactory = (url: string, headers: Record<string, string>) => AgentSocket;

export interface DeepgramRealtimeProviderOptions {
  apiKey: string;
  /** The `agent.think` provider and model. Defaults to `DEFAULT_DEEPGRAM_THINK`. */
  think?: { provider: string; model: string };
  /** The `agent.listen` Flux model. Defaults to `DEFAULT_DEEPGRAM_LISTEN_MODEL`. */
  listenModel?: string;
  voice?: string;
  /** Speak pace, 0.7 to 1.5. Defaults to `DEFAULT_DEEPGRAM_SPEED`. A value
   * outside that range, or a non-finite one, is rejected at construction. */
  speed?: number;
  wsFactory?: WsFactory;
  /** How long `connect` waits for `SettingsApplied` before rejecting. */
  settingsTimeoutMs?: number;
}

/** Provider options with every default applied — the input
 * `buildDeepgramSettings` needs, so the harness and production build the
 * same Settings from the same values. */
export interface ResolvedDeepgramOptions {
  think: { readonly provider: string; readonly model: string };
  listenModel: string;
  voice: string;
  speed: number;
}

export interface DeepgramFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  defer_until_eot: true;
}

/** The `Settings` message, exactly as sent. */
export interface DeepgramSettings {
  type: "Settings";
  mip_opt_out: true;
  audio: {
    input: { encoding: string; sample_rate: number };
    output: { encoding: string; sample_rate: number; container: "none" };
  };
  agent: {
    language: "en";
    listen: {
      provider: { type: "deepgram"; version: "v2"; model: string; keyterms?: string[] };
    };
    think: {
      provider: { type: string; model: string };
      prompt: string;
      functions?: DeepgramFunctionDeclaration[];
    };
    speak: {
      provider: { type: "deepgram"; version?: "v1" | "v2"; model: string; speed: number };
    };
  };
}

/** Deepgram serves Flux TTS at speak v2 and Aura at v1; a Flux voice sent
 * without the version is rejected. Unknown families get no version and
 * Deepgram's own default. */
function speakProvider(
  voice: string,
  speed: number
): DeepgramSettings["agent"]["speak"]["provider"] {
  const version = voice.startsWith("flux-") ? "v2" : voice.startsWith("aura-") ? "v1" : undefined;
  return { type: "deepgram", ...(version ? { version } : {}), model: voice, speed };
}

/** Build the one `Settings` message for a session. Pure: no socket, no
 * clock, so the harness can reuse it and harness Settings cannot drift from
 * production's. `params.model` is not read — Deepgram's model choice is the
 * `think` option, because swapping it per connect would also mean reasoning
 * about the managed-provider credential behind it. */
export function buildDeepgramSettings(
  params: RealtimeConnectParams,
  opts: ResolvedDeepgramOptions
): DeepgramSettings {
  const encoding = {
    encoding: DEEPGRAM_AUDIO_ENCODING.codec,
    sample_rate: DEEPGRAM_AUDIO_ENCODING.sampleRate
  };
  return {
    type: "Settings",
    // Call audio is third-party speech: never opt it into Deepgram's
    // model-improvement programme.
    mip_opt_out: true,
    audio: { input: encoding, output: { ...encoding, container: "none" } },
    agent: {
      language: "en",
      listen: {
        provider: {
          type: "deepgram",
          version: "v2",
          model: opts.listenModel,
          ...(params.keyterms && params.keyterms.length > 0
            ? { keyterms: [...params.keyterms] }
            : {})
        }
      },
      think: {
        provider: { type: opts.think.provider, model: opts.think.model },
        // Sent exactly once, here, as part of Settings — never again for the
        // life of the session (core/types.ts).
        prompt: params.systemInstruction,
        // Omitted entirely when the caller declared none: a session with no
        // execution plane is byte-identical to Parley before tools existed.
        ...(params.tools && params.tools.length > 0
          ? {
              functions: params.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parametersJsonSchema,
                // Hold the call until the caller's turn has ended. A call
                // fired mid-sentence can act on half a request, and ToolGate
                // effects (a keypress, a hang-up) cannot be taken back.
                defer_until_eot: true as const
              }))
            }
          : {})
      },
      speak: { provider: speakProvider(params.voice ?? opts.voice, opts.speed) }
    }
  };
}

interface DeepgramFunctionCallEntry {
  id?: string;
  name?: string;
  arguments?: string;
  client_side?: boolean;
}

interface DeepgramAgentMessage {
  type?: string;
  role?: "user" | "assistant";
  content?: string;
  functions?: DeepgramFunctionCallEntry[];
  id?: string;
  code?: string;
  description?: string;
  message?: string;
  total_latency?: number;
  tts_latency?: number;
  ttt_latency?: number;
}

/** The real socket. Exported so the harness's scenario transport opens the
 * agent socket exactly as production does, without taking its own `ws`
 * dependency. */
export const defaultWsFactory: WsFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as AgentSocket;

/** A RealtimeProvider over Deepgram's Voice Agent API (STT -> LLM -> TTS on
 * one socket, mu-law 8k both directions — no resampling on the call path). A
 * factory function, matching `@parley/transcription-deepgram`'s
 * `createDeepgramTranscriptionProvider`.
 *
 * The returned `RealtimeSession` is deliberately as narrow as Gemini's:
 * `sendOpeningTrigger` / `sendAudio` / `notifyActivityEnd` /
 * `sendToolResponse` / `close`, nothing else. It never sends
 * `InjectAgentMessage` (Deepgram speaks that verbatim, bypassing the LLM, so
 * the callee would hear Parley's private instruction) nor any `Update*`
 * message (a mid-session re-instruction). */
export function createDeepgramRealtimeProvider(
  opts: DeepgramRealtimeProviderOptions
): RealtimeProvider {
  const apiKey = opts.apiKey;
  const speed = opts.speed ?? DEFAULT_DEEPGRAM_SPEED;
  if (!Number.isFinite(speed) || speed < DEEPGRAM_SPEED_MIN || speed > DEEPGRAM_SPEED_MAX) {
    throw new Error(
      `deepgram: speed must be a number from ${DEEPGRAM_SPEED_MIN} to ${DEEPGRAM_SPEED_MAX}`
    );
  }
  const resolved: ResolvedDeepgramOptions = {
    think: opts.think ?? DEFAULT_DEEPGRAM_THINK,
    listenModel: opts.listenModel ?? DEFAULT_DEEPGRAM_LISTEN_MODEL,
    voice: opts.voice ?? DEFAULT_DEEPGRAM_VOICE,
    speed
  };
  const settingsTimeoutMs = opts.settingsTimeoutMs ?? DEFAULT_SETTINGS_TIMEOUT_MS;
  const wsFactory = opts.wsFactory ?? defaultWsFactory;

  return {
    name: "deepgram",
    // The carrier's own encoding both ways, so CallSession's bridges pass
    // every frame straight through: zero conversions on the call path.
    audio: { accepts: [DEEPGRAM_AUDIO_ENCODING], emits: DEEPGRAM_AUDIO_ENCODING },
    // The Voice Agent API caps one session at two hours.
    maxSessionSeconds: 7200,
    // Its only post-connect text input is a USER turn, so Parley's opening
    // goes in the Settings prompt — see OPENING_TRIGGER_MAX_CHARS above.
    openingDelivery: "prompt",
    // The agent's LLM emits `FunctionCallRequest` first; the words that go
    // with the call are spoken by the turn it runs after our
    // `FunctionCallResponse` (billed wire logs: a goodbye starting ~190 ms
    // after the answer and running 6.7 s; "Thanks, Brenda." / "Goodbye." from
    // +705 ms). See `RealtimeProvider.continuesAfterToolResponse`.
    continuesAfterToolResponse: true,

    async connect(params: RealtimeConnectParams): Promise<RealtimeSession> {
      const { callbacks } = params;
      let socket: AgentSocket;
      try {
        // The key travels in a header and never in the URL — a URL reaches
        // logs, proxies and error messages; a header does not.
        socket = wsFactory(DEEPGRAM_AGENT_URL, { Authorization: `Token ${apiKey}` });
      } catch {
        // Deliberately does NOT re-raise the underlying error: it may quote
        // the request, and the request carries the credential.
        throw new Error("deepgram: could not open agent socket");
      }

      const settings = buildDeepgramSettings(params, resolved);

      // `ready` means Deepgram has APPLIED the settings, not merely that the
      // socket opened: audio sent before then would be interpreted under
      // settings the agent has not accepted.
      let ready = false;
      let closed = false;
      let keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
      // Tool calls Deepgram has cancelled, whose late answers must be dropped.
      const cancelledCalls = new Set<string>();
      // Texts this provider injected as user turns, each awaiting its echo.
      // Deepgram echoes every `InjectUserMessage` back as a user
      // `ConversationText`, which would otherwise be reported as the far end
      // speaking — on a meeting, `MEETING_CONNECTED_CUE` recorded as a
      // participant's words in the pre-consent buffer. A list, not a set: two
      // injections of the same text are two echoes.
      const pendingEchoes: string[] = [];
      // A turn ends when its audio has stopped, not on its first
      // AgentAudioDone — see DEEPGRAM_TURN_QUIET_MS.
      // When the last AgentAudioDone arrived, while its quiet window is still
      // pending; audio after it is reported once as a timing diagnostic.
      let doneAt: number | undefined;
      const turn = createDeepgramTurnCompletion(() => {
        doneAt = undefined;
        if (!closed) callbacks.onTurnComplete?.();
      });

      const armKeepAlive = (): void => {
        clearTimeout(keepAliveTimer);
        if (closed) return;
        keepAliveTimer = setTimeout(() => {
          socket.send(JSON.stringify({ type: "KeepAlive" }));
          armKeepAlive();
        }, KEEPALIVE_INTERVAL_MS);
      };
      const stopKeepAlive = (): void => {
        clearTimeout(keepAliveTimer);
        keepAliveTimer = undefined;
      };

      // Pending until the handshake settles either way; undefined after.
      let settle: { resolve: () => void; reject: (err: Error) => void } | undefined;
      const handshake = new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      });
      const timeout = setTimeout(() => {
        failHandshake(new Error("deepgram: no SettingsApplied within the settings timeout"));
      }, settingsTimeoutMs);
      // Rejects connect once, closing the socket; a no-op once settled.
      function failHandshake(err: Error): void {
        if (!settle) return;
        clearTimeout(timeout);
        const pending = settle;
        settle = undefined;
        closed = true;
        socket.close();
        pending.reject(err);
      }

      socket.on("open", (() => {
        socket.send(JSON.stringify(settings));
      }) as never);

      socket.on("error", ((err: Error) => {
        // Connect already rejected; this is the echo of our own close (ws
        // reports aborting a still-connecting socket as an error).
        if (!ready && !settle) return;
        const message = err instanceof Error ? err.message : "unknown Deepgram agent error";
        // DISCLOSED DIVERGENCE from GeminiRealtimeProvider, which reports
        // `fatal: true` unconditionally. A socket error before settings apply
        // means the session never came up — fatal. One on a live session is a
        // transient fault, reported non-fatal rather than collapsed into the
        // same signal. Both branches: test/on-error-fatal.test.ts.
        callbacks.onError({ code: "deepgram_agent_error", message, fatal: !ready });
        if (!ready) failHandshake(new Error("deepgram: agent socket failed to open"));
      }) as never);

      socket.on("message", ((raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          turn.audio();
          if (doneAt !== undefined) {
            // Content-free: how long after AgentAudioDone the reply went on.
            callbacks.onDiagnostic?.(
              `deepgram audio resumed ${Math.round(Date.now() - doneAt)}ms after AgentAudioDone`
            );
            doneAt = undefined;
          }
          callbacks.onAudio({ encoding: DEEPGRAM_AUDIO_ENCODING, data: raw });
          return;
        }
        let msg: DeepgramAgentMessage;
        try {
          msg = JSON.parse(raw.toString()) as DeepgramAgentMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "SettingsApplied":
            if (!settle) return;
            clearTimeout(timeout);
            ready = true;
            armKeepAlive();
            settle.resolve();
            settle = undefined;
            return;

          case "Error": {
            // Connect already rejected (the settings timeout, or a socket
            // error): the rejection was the whole signal, and there is no
            // session left for this to be fatal to. Same guard as the
            // socket-error handler above.
            if (!ready && !settle) return;
            const message = `${msg.code ?? "unknown"}: ${msg.description ?? "no description"}`;
            // Fatal before ready: the settings were refused and there is no
            // session. After ready Deepgram keeps the socket open, so the
            // session is left to decide; the vendor's error codes are not
            // documented as an exhaustive set, so none is treated as fatal
            // here — a socket close is what ends a session.
            callbacks.onError({ code: "deepgram_agent_error", message, fatal: !ready });
            if (!ready) failHandshake(new Error(`deepgram: agent refused settings (${message})`));
            return;
          }

          case "Warning":
            callbacks.onDiagnostic?.(
              `deepgram Warning ${msg.code ?? "unknown"}: ${msg.description ?? "no description"}`
            );
            return;

          case "InjectionRefused":
            // The opening trigger arrived while the agent could not take it
            // (e.g. mid-speech). Surfaced, not retried: a retry is a second
            // privileged input.
            callbacks.onDiagnostic?.(`deepgram InjectionRefused: ${msg.message ?? "no reason"}`);
            return;

          case "LatencyReport": {
            // What the current Voice Agent API sends: one message per measure,
            // each carrying a single numeric field (ttt_token_latency,
            // ttt_text_latency, tts_latency, total_latency, ttt_tool_latency),
            // in seconds. Logged as integer ms, field name as sent. Timing
            // only — no content. Unknown or non-numeric fields are ignored.
            for (const field of LATENCY_FIELDS) {
              const v = (msg as Record<string, unknown>)[field];
              if (typeof v === "number" && Number.isFinite(v)) {
                callbacks.onDiagnostic?.(`deepgram latency ${field}=${Math.round(v * 1000)}ms`);
              }
            }
            return;
          }

          case "AgentStartedSpeaking":
            // Older shape; the current API sends LatencyReport instead and
            // never this message. Kept in case a version sends it again.
            // Seconds, as Deepgram reports them. Timing only — no content.
            callbacks.onDiagnostic?.(
              `deepgram latency total=${msg.total_latency} tts=${msg.tts_latency} ttt=${msg.ttt_latency}`
            );
            return;

          case "AgentAudioDone":
            // NOT yet the turn end the farewell and consent drains wait on:
            // Deepgram can send more of the same reply after it. The turn is
            // complete once the audio has then stayed quiet for
            // DEEPGRAM_TURN_QUIET_MS; audio inside that window cancels it and
            // the next AgentAudioDone re-arms it.
            turn.audioDone();
            doneAt = Date.now();
            return;

          case "UserStartedSpeaking":
            // Deepgram's barge-in signal — the caller started talking over
            // the agent (Gemini's serverContent.interrupted).
            callbacks.onInterrupted();
            return;

          case "ConversationText": {
            // The first user utterance matching a line WE injected is its
            // echo, not speech. Exact match, once: a real utterance never
            // equals it by accident in practice, and if a participant does
            // say the same words later, that one is heard.
            if (msg.role === "user") {
              const echo = pendingEchoes.indexOf(msg.content ?? "");
              if (echo >= 0) {
                pendingEchoes.splice(echo, 1);
                callbacks.onDiagnostic?.("deepgram dropped the echo of an injected line");
                return;
              }
            }
            const speaker: SpeakerRole =
              msg.role === "assistant" ? "model" : (params.speakerRole ?? "caller");
            // One complete utterance per event, not a growing partial the
            // way Gemini's outputTranscription streams — so isFinal:true.
            callbacks.onTranscript({ speaker, text: msg.content ?? "", isFinal: true });
            return;
          }

          case "FunctionCallRequest":
            for (const fc of msg.functions ?? []) {
              // A server-side function is Deepgram's to answer. Answering it
              // from here would put a second response on the wire. Parley
              // declares no endpoint, so every function of ours is
              // client-side; only an explicit `false` is someone else's.
              if (fc.client_side === false) continue;
              // No id or name means no way to address a response, and an
              // unanswered tool call stalls the model's turn.
              if (!fc.id || !fc.name) continue;
              let args: Record<string, unknown> = {};
              if (fc.arguments) {
                try {
                  args = JSON.parse(fc.arguments) as Record<string, unknown>;
                } catch {
                  // Malformed arguments: treat as none, so ToolGate's own
                  // argument validation is what refuses the call.
                }
              }
              callbacks.onToolCall?.({ id: fc.id, name: fc.name, args });
            }
            return;

          case "FunctionCallCancelled": {
            // UNVERIFIED shape: Deepgram's docs name this message but do not
            // show its fields. Accept a top-level `id` and any
            // `functions[].id`. The call has already been routed (routing is
            // synchronous on receipt) and ToolGate's effects are not
            // reversible, so all this can do is say so and drop the late
            // answer.
            const ids = [msg.id, ...(msg.functions ?? []).map((f) => f.id)].filter(
              (id): id is string => typeof id === "string" && id.length > 0
            );
            for (const id of ids) {
              cancelledCalls.add(id);
              callbacks.onDiagnostic?.(`deepgram FunctionCallCancelled: id=${id}`);
            }
            return;
          }

          default:
            return;
        }
      }) as never);

      socket.on("close", ((code: number, reason: Buffer) => {
        closed = true;
        stopKeepAlive();
        turn.cancel();
        if (!ready) {
          // A session that never came up has nothing to report closed: the
          // rejected connect is the whole signal (a no-op if it already failed).
          failHandshake(new Error("deepgram: agent socket closed before SettingsApplied"));
          return;
        }
        ready = false;
        callbacks.onClose(
          `code=${code ?? "unknown"} reason=${reason?.toString().trim() || "none"}`
        );
      }) as never);

      await handshake;

      return {
        sendOpeningTrigger(text: string) {
          if (text.length > OPENING_TRIGGER_MAX_CHARS || text.includes("\n")) {
            throw new Error(OPENING_TRIGGER_REJECTED);
          }
          // A USER turn the LLM answers — never InjectAgentMessage, which
          // Deepgram's TTS would read aloud to the callee word for word.
          pendingEchoes.push(text);
          socket.send(JSON.stringify({ type: "InjectUserMessage", content: text }));
        },
        sendAudio(frame: AudioFrame) {
          if (!encodingEquals(frame.encoding, DEEPGRAM_AUDIO_ENCODING)) {
            throw new Error(
              `DeepgramRealtimeProvider.sendAudio requires ${formatEncoding(DEEPGRAM_AUDIO_ENCODING)} frames; received ${formatEncoding(frame.encoding)}`
            );
          }
          socket.send(frame.data);
          armKeepAlive();
        },
        sendToolResponse(call: ToolCallRequest, result: ToolResult) {
          // Deepgram withdrew this call; an answer now would land on a turn
          // that no longer expects it.
          if (cancelledCalls.has(call.id)) {
            callbacks.onDiagnostic?.(
              `deepgram dropped response for cancelled function call id=${call.id}`
            );
            return;
          }
          // `content` is the closed ToolResult union, stringified as-is —
          // never an argument, a callee utterance, or an error message.
          socket.send(
            JSON.stringify({
              type: "FunctionCallResponse",
              id: call.id,
              name: call.name,
              content: result
            })
          );
        },
        notifyActivityEnd() {
          // No-op: Flux does its own end-of-turn detection.
        },
        async close() {
          // No documented client-initiated close message exists for the
          // Voice Agent socket; closing the socket directly is what the docs
          // support.
          closed = true;
          stopKeepAlive();
          turn.cancel();
          socket.close();
        }
      };
    }
  };
}

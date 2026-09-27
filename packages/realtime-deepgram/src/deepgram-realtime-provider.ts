import {
  encodingEquals,
  formatEncoding,
  MULAW_8K,
  type AudioFrame,
  type RealtimeConnectParams,
  type RealtimeProvider,
  type RealtimeSession,
  type SpeakerRole,
  type ToolCallRequest,
  type ToolResult
} from "@parley/core";
import WebSocket from "ws";

/** Verified against Deepgram's public Voice Agent docs on 2026-08-19
 * (developers.deepgram.com/docs/build-a-voice-agent and
 * developers.deepgram.com/reference/voice-agent/voice-agent — fetched, not
 * recalled). Regional variants exist (`api.eu.deepgram.com`,
 * `api.au.deepgram.com`) but are out of scope for this spike. One exported
 * constant so this has exactly one place to be wrong. */
export const DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";

/** Deepgram's own STT model for the `agent.listen` leg. Matches
 * `@parley/transcription-deepgram`'s `DEEPGRAM_DEFAULT_MODEL` for consistency
 * across the two Deepgram-backed providers in this repo. Not exposed as a
 * caller-configurable option — the brief's provider options are
 * `{ apiKey, voice, llmModel, wsFactory }`, and this is not one of them. */
const DEEPGRAM_LISTEN_MODEL = "nova-3";

/** `open_ai` is one of Deepgram's four MANAGED `think` providers (alongside
 * `anthropic`, `google`, `nvidia`) — confirmed via Deepgram's LLM-providers
 * docs: managed providers need no `endpoint` and no separate vendor API key,
 * only the Deepgram key already on this connection. `gpt-4o-mini` matches the
 * literal example on developers.deepgram.com/docs/voice-agent-settings. */
export const DEFAULT_DEEPGRAM_LLM_MODEL = "gpt-4o-mini";

/** Han named "Meghan" as a voice preference. Checked against Deepgram's
 * current Aura and Aura-2 catalogue (developers.deepgram.com/docs/tts-models,
 * fetched 2026-08-19, full alphabetical listing) — no voice of that name
 * exists, under either catalogue generation. `aura-2-cordelia-en` is the
 * nearest verified alternative by Deepgram's own one-line character
 * description ("Approachable, Warm, Polite"); `aura-2-helena-en` ("Caring,
 * Natural, Positive, Friendly, Raspy") and `aura-2-juno-en` ("Natural,
 * Engaging, Melodic, Breathy") are the next-nearest. This is a provisional
 * default for the spike, not a decision on Han's behalf — see the verdict
 * doc. Overridable per-provider via `opts.voice` or per-connect via
 * `RealtimeConnectParams.voice`. */
export const DEFAULT_DEEPGRAM_VOICE = "aura-2-cordelia-en";

/** `sendOpeningTrigger`'s only job is one short "begin talking now" line
 * (design spec §4.1, same contract as Gemini's). Deepgram's
 * `InjectAgentMessage` is a general free-text injection primitive with no
 * Gemini counterpart — nothing stops a caller from using it to restate a
 * persona or slip in new rules mid-session. This bound, and the fixed
 * rejection below, are what keep it from becoming exactly the re-instruction
 * escape hatch `packages/core/src/types.ts` says a `RealtimeSession` must
 * never expose. */
const OPENING_TRIGGER_MAX_CHARS = 120;
const OPENING_TRIGGER_REJECTED =
  "sendOpeningTrigger accepts only one short line to start the call — reject anything longer " +
  "than about a sentence or containing a newline. Deepgram's InjectAgentMessage has no Gemini " +
  "counterpart and must never become a mid-session re-instruction path.";

export interface AgentSocket {
  on(event: "open" | "message" | "close" | "error", fn: (...args: never[]) => void): void;
  send(data: Buffer | string): void;
  close(): void;
}

export type WsFactory = (url: string, headers: Record<string, string>) => AgentSocket;

export interface DeepgramRealtimeProviderOptions {
  apiKey: string;
  voice?: string;
  llmModel?: string;
  wsFactory?: WsFactory;
}

interface DeepgramFunctionCallEntry {
  id?: string;
  name?: string;
  arguments?: string;
}

interface DeepgramAgentMessage {
  type?: string;
  role?: "user" | "assistant";
  content?: string;
  functions?: DeepgramFunctionCallEntry[];
}

const defaultWsFactory: WsFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as AgentSocket;

/** The spike RealtimeProvider implementation over Deepgram's Voice Agent API
 * (STT -> LLM -> TTS on one socket, mu-law 8k both directions — no
 * resampling on the call path, unlike Gemini's pcm@16000/pcm@24000). A
 * factory function, not a class, matching
 * `@parley/transcription-deepgram`'s `createDeepgramTranscriptionProvider`
 * — the sibling Deepgram-branded provider in this repo — rather than
 * `@parley/realtime-gemini`'s class shape.
 *
 * The returned `RealtimeSession` is deliberately as narrow as Gemini's:
 * `sendOpeningTrigger` / `sendAudio` / `notifyActivityEnd` /
 * `sendToolResponse` / `close`, nothing else. There is no method that
 * resends `systemInstruction` and no general "push a new turn" escape
 * hatch — see the guard on `sendOpeningTrigger` above. */
export function createDeepgramRealtimeProvider(
  opts: DeepgramRealtimeProviderOptions
): RealtimeProvider {
  const apiKey = opts.apiKey;
  const providerVoice = opts.voice ?? DEFAULT_DEEPGRAM_VOICE;
  const llmModel = opts.llmModel ?? DEFAULT_DEEPGRAM_LLM_MODEL;
  const wsFactory = opts.wsFactory ?? defaultWsFactory;

  return {
    name: "deepgram",

    async connect(params: RealtimeConnectParams): Promise<RealtimeSession> {
      let socket: AgentSocket;
      try {
        // The key travels in a header and never in the URL, matching
        // @parley/transcription-deepgram — a URL reaches logs, proxies and
        // error messages; a header does not.
        socket = wsFactory(DEEPGRAM_AGENT_URL, { Authorization: `Token ${apiKey}` });
      } catch {
        // Deliberately does NOT re-raise the underlying error: it may quote
        // the request, and the request carries the credential.
        throw new Error("deepgram: could not open agent socket");
      }

      let ready = false;

      // `agent.think.provider.model` is set from the PROVIDER-level
      // `llmModel` option, not from `params.model`. That is a real departure
      // from Gemini's own design comment ("model selection is a per-connect
      // parameter, not provider-level config") — but the brief's factory
      // signature fixes `llmModel` as a constructor option, and Deepgram's
      // think-provider selection is not something a caller should be able to
      // swap per connect without also reasoning about the managed-provider
      // credential behind it. `params.model` is still accepted, to satisfy
      // the RealtimeConnectParams contract, and is otherwise unused here.
      const settings = {
        type: "Settings",
        audio: {
          input: { encoding: MULAW_8K.codec, sample_rate: MULAW_8K.sampleRate },
          output: { encoding: MULAW_8K.codec, sample_rate: MULAW_8K.sampleRate, container: "none" }
        },
        agent: {
          language: "en",
          listen: { provider: { type: "deepgram", model: DEEPGRAM_LISTEN_MODEL } },
          think: {
            provider: { type: "open_ai", model: llmModel },
            // Sent exactly once, here, as part of Settings — never again for
            // the life of the session (design spec §4, core/types.ts).
            prompt: params.systemInstruction,
            // Omitted entirely when the caller declared none, matching
            // Gemini's contract: a session with no execution plane is
            // byte-identical to Parley before tools existed.
            ...(params.tools && params.tools.length > 0
              ? {
                  functions: params.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parametersJsonSchema
                  }))
                }
              : {})
          },
          speak: { provider: { type: "deepgram", model: params.voice ?? providerVoice } }
        }
      };

      await new Promise<void>((resolve, reject) => {
        socket.on("open", (() => {
          ready = true;
          socket.send(JSON.stringify(settings));
          resolve();
        }) as never);
        socket.on("error", ((err: Error) => {
          const message = err instanceof Error ? err.message : "unknown Deepgram agent error";
          // DISCLOSED DIVERGENCE from GeminiRealtimeProvider, which reports
          // `fatal: true` unconditionally (gemini-realtime-provider.ts). A
          // socket error before the handshake completes means the session
          // never came up and there is nothing left to recover from — fatal.
          // An error on an already-open socket is a transient fault on an
          // otherwise live session, which is a materially different
          // situation, so it is reported as non-fatal instead of collapsed
          // into the same signal. Both branches are covered by
          // test/on-error-fatal.test.ts.
          params.callbacks.onError({ code: "deepgram_agent_error", message, fatal: !ready });
          if (!ready) reject(new Error("deepgram: agent socket failed to open"));
        }) as never);
      });

      socket.on("message", ((raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          params.callbacks.onAudio({ encoding: MULAW_8K, data: raw });
          return;
        }
        let msg: DeepgramAgentMessage;
        try {
          msg = JSON.parse(raw.toString()) as DeepgramAgentMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "UserStartedSpeaking":
            // Deepgram's barge-in signal — the caller started talking over
            // the agent. Same event RealtimeSessionCallbacks.onInterrupted
            // exists for on the Gemini side (serverContent.interrupted).
            params.callbacks.onInterrupted();
            return;

          case "ConversationText": {
            const speaker: SpeakerRole =
              msg.role === "assistant" ? "model" : (params.speakerRole ?? "caller");
            // Deepgram's ConversationText carries one complete utterance per
            // event, not a growing partial the way Gemini's
            // outputTranscription streams — so isFinal:true unconditionally.
            // UNVERIFIED against a live session: the docs describe the
            // message shape but not its partial/final delivery cadence, and
            // this task makes no live call to check.
            params.callbacks.onTranscript({
              speaker,
              text: msg.content ?? "",
              isFinal: true
            });
            return;
          }

          case "FunctionCallRequest":
            for (const fc of msg.functions ?? []) {
              // No id or name means no way to address a response, and an
              // unanswered tool call stalls the model's turn — same rule as
              // Gemini's onmessage handler.
              if (!fc.id || !fc.name) continue;
              let args: Record<string, unknown> = {};
              if (fc.arguments) {
                try {
                  args = JSON.parse(fc.arguments) as Record<string, unknown>;
                } catch {
                  // Malformed arguments JSON: treat as no arguments rather
                  // than dropping the call outright, so ToolGate's own
                  // argument validation is what refuses it.
                }
              }
              params.callbacks.onToolCall?.({ id: fc.id, name: fc.name, args });
            }
            return;

          default:
            return;
        }
      }) as never);

      socket.on("close", ((code: number, reason: Buffer) => {
        ready = false;
        params.callbacks.onClose(
          `code=${code ?? "unknown"} reason=${reason?.toString().trim() || "none"}`
        );
      }) as never);

      return {
        sendOpeningTrigger(text: string) {
          if (text.length > OPENING_TRIGGER_MAX_CHARS || text.includes("\n")) {
            throw new Error(OPENING_TRIGGER_REJECTED);
          }
          socket.send(JSON.stringify({ type: "InjectAgentMessage", message: text }));
        },
        sendAudio(frame: AudioFrame) {
          if (!encodingEquals(frame.encoding, MULAW_8K)) {
            throw new Error(
              `DeepgramRealtimeProvider.sendAudio requires mulaw@8000 frames; received ${formatEncoding(frame.encoding)}`
            );
          }
          socket.send(frame.data);
        },
        sendToolResponse(call: ToolCallRequest, result: ToolResult) {
          // `content` is the closed ToolResult union, stringified as-is —
          // never an argument, a callee utterance, or an error message. The
          // compiler enforces the union at this call site; see
          // packages/core/src/execution.ts.
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
          // No-op under automatic VAD, same as Gemini — Parley V1 always
          // connects with Deepgram's default automatic turn-taking, never
          // manual signaling.
        },
        async close() {
          // No documented client-initiated close-handshake message was found
          // for the Voice Agent socket (unlike transcription's `CloseStream`
          // marker) — closing the socket directly is what the fetched docs
          // support.
          socket.close();
        }
      };
    }
  };
}

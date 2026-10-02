import { Behavior, GoogleGenAI, Modality, TurnCoverage } from "@google/genai";
import {
  encodingEquals,
  formatEncoding,
  PCM_16K,
  PCM_24K,
  type AudioFrame,
  type RealtimeAudioFormat,
  type RealtimeConnectParams,
  type RealtimeProvider,
  type RealtimeSession,
  type ToolCallRequest,
  type ToolDeclaration,
  type ToolResult
} from "@parley/core";

/** Parley's V1 fixed model (design spec §4.5). Exported so callers building a
 * RealtimeConnectParams know what to pass — model selection is a per-connect
 * parameter on the RealtimeProvider interface, not provider-level config. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-live";
/** Pinned default voice so every call sounds like the same assistant. Without a
 * voice the model picks one per session (male/female varies call to call). A
 * caller may still override via RealtimeConnectParams.voice. */
export const DEFAULT_GEMINI_VOICE = "Aoede";
/** The Live API's prebuilt voices — what a per-call `execution.realtime.voice`
 * may name on Gemini. `@parley/server` checks membership against this list
 * and refuses anything else before dialling, so a typo is a 400 rather than a
 * session the vendor refuses after the callee has already answered. */
export const GEMINI_VOICES: readonly string[] = Object.freeze([
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat"
]);
const DEFAULT_API_VERSION = "v1beta";

export interface GeminiRealtimeProviderOptions {
  apiKey: string;
  apiVersion?: string;
}

/** Parley's tool declarations as Gemini Live function declarations. Exported
 * so the harness declares tools exactly as a real call does: a harness that
 * declared them differently would be measuring a different model. */
export function geminiFunctionDeclarations(tools: readonly ToolDeclaration[]): {
  name: string;
  description: string;
  behavior: Behavior;
  parametersJsonSchema: unknown;
}[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // gemini-3.8-live defaults function calls to NON-blocking: the model keeps
    // talking while the call runs. ToolGate needs request/response — one
    // call, one answer, then the model resumes — so every declaration opts
    // back in. Never send thinkingLevel/thinkingConfig either: 3.8 does not
    // support it.
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: t.parametersJsonSchema
  }));
}

type GenAIFactory = (options: {
  apiKey: string;
  httpOptions: { apiVersion: string };
}) => GoogleGenAI;

/** The V1 RealtimeProvider implementation over Gemini Live's official SDK.
 * Ported from scripts/voicecall-realtime-textprobe.mjs's proven connection
 * logic. Deliberately narrow: the returned RealtimeSession exposes only
 * sendOpeningTrigger/sendAudio/notifyActivityEnd/close — there is no code path
 * back to session.sendClientContent or any other way to push a second
 * privileged turn (design spec §7.2). */
export class GeminiRealtimeProvider implements RealtimeProvider {
  readonly name = "gemini";
  /** Gemini Live takes 16 kHz PCM in and speaks 24 kHz PCM out, so
   * CallSession converts both directions against a mu-law carrier. */
  readonly audio: RealtimeAudioFormat = { accepts: [PCM_16K], emits: PCM_24K };
  /** A two-party call's opening rides in the system instruction and nothing
   * is sent at connect; a meeting's goes as its own turn, as it always has.
   *
   * Two-party: sent as its own turn at connect, the trigger is a turn the
   * model answers — and with line hiss or silence before the callee's
   * "hello" it answered into the noise. Measured offline (Gemini 3.8, 3 s of
   * hiss before the hello): audible speech before the callee in 9/18 runs as
   * a turn, 0/72 in the prompt; end-of-hello to first audio also fell, median
   * 1566 → 1316 ms. With nothing sent, the model's first input is the far
   * end's own audio: a person's "hello", a voicemail greeting or an IVR menu
   * is speech, Gemini's activity detection ends that turn, and the model
   * answers it under the same opening text — greet a person, leave the
   * message, work the menu once it has finished. A line that stays silent
   * gives it no turn to take, so it says nothing, which is what the opening
   * asks for anyway; the call's own silence timers end that call as before.
   *
   * Meeting: `MEETING_OPENING_TRIGGER` is still sent as a turn, byte for byte
   * as before. Gemini meetings have never run any other way, and saying
   * nothing until people are heard is the consent invariant — a two-party
   * finding is not evidence for changing it. See `OpeningDeliveryByShape`. */
  readonly openingDelivery = { twoParty: "prompt", meeting: "turn" } as const;
  /** Every function is declared `behavior: BLOCKING`, so the model holds its
   * turn while a call is outstanding and, once the response arrives, CONTINUES
   * that turn — speaking the words that go with the call — and ends it with
   * `turnComplete`. See `RealtimeProvider.continuesAfterToolResponse`. */
  readonly continuesAfterToolResponse = true;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly genAIFactory: GenAIFactory;

  constructor(
    options: GeminiRealtimeProviderOptions,
    genAIFactory: GenAIFactory = (opts) => new GoogleGenAI(opts)
  ) {
    this.apiKey = options.apiKey;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.genAIFactory = genAIFactory;
  }

  async connect(params: RealtimeConnectParams): Promise<RealtimeSession> {
    const ai = this.genAIFactory({
      apiKey: this.apiKey,
      httpOptions: { apiVersion: this.apiVersion }
    });

    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: params.systemInstruction,
      ...(params.inputTranscription !== false ? { inputAudioTranscription: {} } : {}),
      ...(params.outputTranscription !== false ? { outputAudioTranscription: {} } : {}),
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: params.voice ?? DEFAULT_GEMINI_VOICE } }
      },
      realtimeInputConfig: {
        turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
        automaticActivityDetection: {
          silenceDurationMs: params.turnDetection?.silenceDurationMs ?? 700
        }
      },
      ...(params.contextWindowCompression !== false
        ? { contextWindowCompression: { slidingWindow: {} } }
        : {}),
      // Omitted entirely when the caller declared none, so a session with no
      // execution plane is byte-identical to Parley before tools existed.
      ...(params.tools && params.tools.length > 0
        ? {
            tools: [{ functionDeclarations: geminiFunctionDeclarations(params.tools) }]
          }
        : {})
    };

    let sawModelFinalThisTurn = false;
    // Logged on change only: it rides on most serverContent messages, and one
    // line per message would bury every other diagnostic on a live call.
    let lastInteractionStatus: string | undefined;

    const genAISession = await ai.live.connect({
      model: params.model,
      config,
      callbacks: {
        onopen: () => {},
        onmessage: (message) => {
          // BEFORE the serverContent guard: a toolCall arrives on a sibling
          // field and carries no serverContent, so an early return would drop
          // every tool call the model ever makes.
          for (const fc of message.toolCall?.functionCalls ?? []) {
            // No id means no way to address a response, and an unanswered tool
            // call stalls the model's turn. Dropping it is the lesser failure.
            if (!fc.id || !fc.name) continue;
            params.callbacks.onToolCall?.({ id: fc.id, name: fc.name, args: fc.args ?? {} });
          }

          // The server announces an impending connection end (connections last
          // ~10 min). Transport fact only: nothing here touches call content.
          if (message.goAway) {
            params.callbacks.onDiagnostic?.(
              `gemini goAway: timeLeft=${message.goAway.timeLeft ?? "unknown"}`
            );
          }

          const serverContent = message.serverContent;
          if (!serverContent) return;

          // Surfaced rather than acted on: turnComplete is still our turn-end
          // signal on gemini-3.8-live, and logging this lets a change in what
          // interactionStatus means be noticed instead of silently absorbed.
          if (
            serverContent.interactionStatus &&
            serverContent.interactionStatus !== lastInteractionStatus
          ) {
            lastInteractionStatus = serverContent.interactionStatus;
            params.callbacks.onDiagnostic?.(
              `gemini interactionStatus: ${serverContent.interactionStatus}`
            );
          }

          if (serverContent.outputTranscription?.text) {
            const isFinal = Boolean(serverContent.outputTranscription.finished);
            if (isFinal) sawModelFinalThisTurn = true;
            params.callbacks.onTranscript({
              speaker: "model",
              text: serverContent.outputTranscription.text,
              isFinal
            });
          }

          if (serverContent.inputTranscription?.text) {
            params.callbacks.onTranscript({
              speaker: params.speakerRole ?? "caller",
              text: serverContent.inputTranscription.text,
              isFinal: Boolean(serverContent.inputTranscription.finished)
            });
          }

          for (const part of serverContent.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              params.callbacks.onAudio({
                encoding: PCM_24K,
                data: Buffer.from(part.inlineData.data, "base64")
              });
            }
          }

          if (serverContent.interrupted) {
            params.callbacks.onInterrupted();
          }

          if (serverContent.turnComplete) {
            if (!sawModelFinalThisTurn) {
              params.callbacks.onTranscript({ speaker: "model", text: "", isFinal: true });
            }
            sawModelFinalThisTurn = false;
            params.callbacks.onTurnComplete?.();
          }
        },
        onerror: (event) => {
          const message =
            event?.error instanceof Error ? event.error.message : "unknown Gemini Live error";
          params.callbacks.onError({ code: "gemini_live_error", message, fatal: true });
        },
        onclose: (event) => {
          params.callbacks.onClose(
            `code=${event?.code ?? "unknown"} reason=${event?.reason?.trim() || "none"}`,
            {
              ...(typeof event?.code === "number" ? { code: event.code } : {}),
              ...(event?.reason?.trim() ? { reason: event.reason.trim() } : {})
            }
          );
        }
      }
    });

    return {
      sendOpeningTrigger(text: string) {
        genAISession.sendRealtimeInput({ text });
      },
      sendAudio(frame: AudioFrame) {
        if (!encodingEquals(frame.encoding, PCM_16K)) {
          throw new Error(
            `GeminiRealtimeProvider.sendAudio requires pcm@16000 frames; received ${formatEncoding(frame.encoding)}`
          );
        }
        genAISession.sendRealtimeInput({
          audio: { data: frame.data.toString("base64"), mimeType: "audio/pcm;rate=16000" }
        });
      },
      sendToolResponse(call: ToolCallRequest, result: ToolResult) {
        genAISession.sendToolResponse({
          functionResponses: [{ id: call.id, name: call.name, response: { output: result } }]
        });
      },
      notifyActivityEnd() {
        // No-op under automatic VAD (design spec §7.2) — Parley V1 always
        // connects with automatic activity detection, never manual signaling.
      },
      async close() {
        genAISession.close();
      }
    };
  }
}

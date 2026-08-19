import { GoogleGenAI, Modality, TurnCoverage } from "@google/genai";
import type {
  AudioFrame,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeSession,
  ToolCallRequest,
  ToolResult
} from "@parley/core";

/** Parley's V1 fixed model (design spec §4.5). Exported so callers building a
 * RealtimeConnectParams know what to pass — model selection is a per-connect
 * parameter on the RealtimeProvider interface, not provider-level config. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview";
/** Pinned default voice so every call sounds like the same assistant. Without a
 * voice the model picks one per session (male/female varies call to call). A
 * caller may still override via RealtimeConnectParams.voice. */
export const DEFAULT_GEMINI_VOICE = "Aoede";
const DEFAULT_API_VERSION = "v1beta";

export interface GeminiRealtimeProviderOptions {
  apiKey: string;
  apiVersion?: string;
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
            tools: [
              {
                functionDeclarations: params.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parametersJsonSchema
                }))
              }
            ]
          }
        : {})
    };

    let sawModelFinalThisTurn = false;

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

          const serverContent = message.serverContent;
          if (!serverContent) return;

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
              speaker: "caller",
              text: serverContent.inputTranscription.text,
              isFinal: Boolean(serverContent.inputTranscription.finished)
            });
          }

          for (const part of serverContent.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              params.callbacks.onAudio({
                encoding: "pcm24k",
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
            `code=${event?.code ?? "unknown"} reason=${event?.reason?.trim() || "none"}`
          );
        }
      }
    });

    return {
      sendOpeningTrigger(text: string) {
        genAISession.sendRealtimeInput({ text });
      },
      sendAudio(frame: AudioFrame) {
        if (frame.encoding !== "pcm16k") {
          throw new Error(
            `GeminiRealtimeProvider.sendAudio requires pcm16k frames; received ${frame.encoding}`
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

import { GoogleGenAI, Modality } from "@google/genai";
import { DEFAULT_GEMINI_MODEL, geminiFunctionDeclarations } from "@parley/realtime-gemini";
import type { ScenarioTransport } from "../scenario-transport.js";

export type GenAIFactory = (options: {
  apiKey: string;
  httpOptions: { apiVersion: string };
}) => GoogleGenAI;

interface GeminiTextSession {
  sendRealtimeInput: (i: { text: string }) => void;
  sendToolResponse: (p: unknown) => void;
  close: () => void;
}

/**
 * Gemini Live as a scenario transport: callee lines as realtime text input,
 * the model's words from its output transcription, turn end on
 * `turnComplete`.
 *
 * THIS MAKES BILLED GEMINI CALLS. Never run it in CI.
 */
export function geminiTransport(opts: {
  apiKey: string;
  /** Defaults to production's model, so the matrix measures what calls run. */
  model?: string;
  genAIFactory?: GenAIFactory;
}): ScenarioTransport {
  const model = opts.model ?? DEFAULT_GEMINI_MODEL;
  const factory: GenAIFactory = opts.genAIFactory ?? ((o) => new GoogleGenAI(o));
  let session: GeminiTextSession | undefined;
  /** Set by `close()`, so the close the runner asked for is not reported back
   * to it as the session dying underneath it. */
  let closing = false;

  return {
    // Gemini sends `turnComplete` for every turn, including an empty one, so
    // the continuation after a tool answer always ends with its own event.
    completesAfterToolResponse: true,
    // As `GeminiRealtimeProvider` declares: realtime text input is an input to
    // the session, not the far end speaking, so the trigger goes as a line.
    openingDelivery: "turn",
    async connect({ systemInstruction, tools, on }) {
      const ai = factory({ apiKey: opts.apiKey, httpOptions: { apiVersion: "v1beta" } });
      // The SDK's `live.connect` awaits `setupComplete`, and a refused setup
      // (bad key, unknown model, a tool schema it rejects) arrives as
      // `onerror`/`onclose` DURING that wait, with `connect` never settling.
      // Until it resolves, those reject `connect` — a configuration error,
      // as Deepgram's refused Settings are — and never reach `on.closed`,
      // which would score every run of a batch against a session that never
      // existed.
      let ready = false;
      let failSetup: (err: Error) => void = () => {};
      const setupFailed = new Promise<never>((_, reject) => {
        failSetup = reject;
      });
      const connecting = ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          systemInstruction,
          // Mirror what CallSession sends on a real call. Without this the
          // scenario session drifts from production behaviour over a long
          // conversation, and a scenario that does not behave like a call is
          // not evidence about calls.
          contextWindowCompression: { slidingWindow: {} },
          ...(tools.length > 0
            ? {
                // The production provider's own mapping (every function
                // BLOCKING, no thinking config): a harness declaring tools
                // differently from production measures a different model.
                tools: [{ functionDeclarations: geminiFunctionDeclarations(tools) }]
              }
            : {})
        },
        callbacks: {
          onopen: () => {},
          onmessage: (message) => {
            // Tool calls first, then speech, then completion — the order the
            // runner has always consumed one message in.
            for (const fc of message.toolCall?.functionCalls ?? []) {
              if (!fc.id || !fc.name) continue;
              on.toolCall({ id: fc.id, name: fc.name, args: fc.args ?? {} });
            }
            // After the tool calls, as the production provider orders them.
            for (const part of message.serverContent?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) on.modelAudio?.();
            }
            const delta = message.serverContent?.outputTranscription?.text;
            if (delta) on.modelText(delta);
            if (message.serverContent?.turnComplete) on.turnComplete();
          },
          onerror: (event) => {
            const message =
              event?.error instanceof Error ? event.error.message : "unknown Gemini Live error";
            if (!ready) return failSetup(new Error(`gemini live setup failed: ${message}`));
            on.closed(message);
          },
          onclose: (event) => {
            const reason = `code=${event?.code ?? "unknown"} reason=${event?.reason?.trim() || "none"}`;
            if (!ready) return failSetup(new Error(`gemini live closed during setup: ${reason}`));
            if (closing) return;
            on.closed(`gemini live closed: ${reason}`);
          }
        }
      });
      // `ready` flips the moment the SDK resolves, not a microtask later
      // after the race, so no close can fall in between and be dropped.
      const s = await Promise.race([
        connecting.then((opened) => {
          ready = true;
          return opened;
        }),
        setupFailed
      ]);
      session = s as unknown as GeminiTextSession;
    },
    sendCalleeText(text) {
      session?.sendRealtimeInput({ text });
    },
    sendToolResponse(call, result) {
      session?.sendToolResponse({
        functionResponses: [{ id: call.id, name: call.name, response: { output: result } }]
      });
    },
    async close() {
      closing = true;
      session?.close();
    }
  };
}

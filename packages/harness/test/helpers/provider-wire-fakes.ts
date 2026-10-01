import type { RealtimeProvider, ToolResult } from "@parley/core";
import { createDeepgramRealtimeProvider, DEEPGRAM_TURN_QUIET_MS } from "@parley/realtime-deepgram";
import { GeminiRealtimeProvider } from "@parley/realtime-gemini";

/** What a vendor's server can do to a session, in vendor-neutral terms. Each
 * fake translates these into that vendor's real wire messages, so a test
 * written once against `WireFake` exercises every provider's own parsing. */
export type ServerEvent =
  "audio" | "transcript" | "turnComplete" | "interrupted" | "toolCall" | "fatalError";

export interface ToolCallPayload {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Words the vendor transcribed. `final` is honoured only where the vendor
 * streams partials (Gemini); Deepgram's `ConversationText` is always one whole
 * utterance, so there it is ignored. Defaults: a model fragment is partial, a
 * caller utterance is final — how each arrives on a live call. */
export interface TranscriptPayload {
  speaker: "model" | "caller";
  text: string;
  final?: boolean;
}

/** A tool answer as it left the provider, read back off the wire. */
export interface WireToolResponse {
  id: string;
  name: string;
  result: string;
}

export interface WireFake {
  /** Deliver a server-side event as the vendor's wire format. `audio` takes a
   * `Buffer`; `toolCall` takes a `ToolCallPayload`; `transcript` takes a
   * `TranscriptPayload`; the rest take nothing. */
  serverSays(event: ServerEvent, payload?: Buffer | ToolCallPayload | TranscriptPayload): void;
  /** Every message the provider has sent on the CURRENT connection, in order:
   * the session setup first, then each later send. JSON-shaped, so
   * `JSON.stringify` of an entry is what a wire capture would show. */
  sent(): unknown[];
  /** Complete the vendor's handshake, resolving a pending `connect`. */
  ready(): void;
  /** Tool answers among `sent()`, read back by this vendor's field names. */
  toolResponses(): WireToolResponse[];
  /** How long after `serverSays("turnComplete")` the provider reports the
   * turn complete, given no more audio. Gemini's `turnComplete` is final, so
   * 0; Deepgram's `AgentAudioDone` can be followed by more of the same reply,
   * so its provider first waits `DEEPGRAM_TURN_QUIET_MS` of quiet. A test
   * advances fake time by this much to reach the turn end. */
  readonly turnSettleMs: number;
}

export interface ProviderWireFake {
  name: "gemini" | "deepgram";
  provider: RealtimeProvider;
  wire: WireFake;
}

/** A fresh fake per `connect()`: `wire` always speaks for the most recent
 * connection, so one entry serves every test in a `describe.each`. */
export function providerWireFakes(): ProviderWireFake[] {
  return [geminiFake(), deepgramFake()];
}

// ---------------------------------------------------------------------------
// Gemini: the SDK's `ai.live.connect`, faked at the factory seam.

function geminiFake(): ProviderWireFake {
  let sent: unknown[] = [];
  let onmessage: ((m: unknown) => void) | undefined;
  let onerror: ((e: unknown) => void) | undefined;
  let onclose: ((e: { code: number; reason: string }) => void) | undefined;
  let settle: { resolve: () => void; reject: (e: Error) => void } | undefined;

  const session = {
    sendRealtimeInput: (input: unknown) => void sent.push({ via: "sendRealtimeInput", input }),
    sendToolResponse: (input: unknown) => void sent.push({ via: "sendToolResponse", input }),
    // The SDK's close is a socket close, and a socket close raises `onclose` —
    // the path CallSession's consent handoff has to survive. A silent no-op
    // here would hide that path on Gemini while Deepgram's fake exercises it.
    close: () => onclose?.({ code: 1000, reason: "done" })
  };
  const genAI = {
    live: {
      connect: (params: {
        model: string;
        config: unknown;
        callbacks: {
          onmessage: typeof onmessage;
          onerror: typeof onerror;
          onclose: typeof onclose;
        };
      }) => {
        sent = [{ via: "connect", model: params.model, config: params.config }];
        onmessage = params.callbacks.onmessage;
        onerror = params.callbacks.onerror;
        onclose = params.callbacks.onclose;
        // The SDK resolves once the socket is up and rejects if it never is.
        return new Promise((resolve, reject) => {
          settle = { resolve: () => resolve(session), reject };
        });
      }
    }
  };
  const provider = new GeminiRealtimeProvider({ apiKey: "test-key" }, (() => genAI) as never);

  const wire: WireFake = {
    ready: () => settle?.resolve(),
    sent: () => sent,
    serverSays(event, payload) {
      switch (event) {
        case "audio":
          onmessage?.({
            serverContent: {
              modelTurn: {
                parts: [{ inlineData: { data: (payload as Buffer).toString("base64") } }]
              }
            }
          });
          return;
        case "transcript": {
          const t = payload as TranscriptPayload;
          const field = t.speaker === "model" ? "outputTranscription" : "inputTranscription";
          const finished = t.final ?? t.speaker === "caller";
          onmessage?.({ serverContent: { [field]: { text: t.text, finished } } });
          return;
        }
        case "turnComplete":
          onmessage?.({ serverContent: { turnComplete: true } });
          return;
        case "interrupted":
          onmessage?.({ serverContent: { interrupted: true } });
          return;
        case "toolCall":
          onmessage?.({ toolCall: { functionCalls: [payload as ToolCallPayload] } });
          return;
        case "fatalError":
          // Before the socket is up the SDK rejects `connect`; the provider
          // sees the same failure as a rejected promise, not an event.
          if (settle) settle.reject(new Error("gemini: socket failed"));
          else onerror?.({ error: new Error("gemini: socket failed") });
      }
    },
    turnSettleMs: 0,
    toolResponses: () =>
      sent.flatMap((m) => {
        const msg = m as { via: string; input?: { functionResponses?: unknown[] } };
        if (msg.via !== "sendToolResponse") return [];
        return (msg.input?.functionResponses ?? []).map((r) => {
          const fr = r as { id: string; name: string; response: { output: string } };
          return { id: fr.id, name: fr.name, result: fr.response.output };
        });
      })
  };
  return { name: "gemini", provider, wire };
}

// ---------------------------------------------------------------------------
// Deepgram: the Voice Agent socket, faked at the `wsFactory` seam.

type Handler = (...a: unknown[]) => void;

class FakeAgentSocket {
  readonly sent: unknown[] = [];
  private readonly handlers: Record<string, Handler[]> = {};
  on(event: string, fn: Handler): void {
    (this.handlers[event] ??= []).push(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
  send(data: Buffer | string): void {
    // Binary frames are audio; kept as a marker so `sent()` stays JSON-shaped.
    this.sent.push(
      typeof data === "string" ? JSON.parse(data) : { type: "AudioFrame", byteLength: data.length }
    );
  }
  close(): void {
    this.emit("close", 1000, Buffer.from("done"));
  }
}

function deepgramFake(): ProviderWireFake {
  let socket = new FakeAgentSocket();
  const provider = createDeepgramRealtimeProvider({
    apiKey: "test-key",
    wsFactory: () => {
      socket = new FakeAgentSocket();
      return socket as never;
    }
  });
  const agentSays = (message: Record<string, unknown>): void =>
    socket.emit("message", Buffer.from(JSON.stringify(message)), false);

  const wire: WireFake = {
    ready() {
      socket.emit("open");
      agentSays({ type: "SettingsApplied" });
    },
    sent: () => socket.sent,
    serverSays(event, payload) {
      switch (event) {
        case "audio":
          socket.emit("message", payload as Buffer, true);
          return;
        case "transcript": {
          const t = payload as TranscriptPayload;
          agentSays({
            type: "ConversationText",
            role: t.speaker === "model" ? "assistant" : "user",
            content: t.text
          });
          return;
        }
        case "turnComplete":
          agentSays({ type: "AgentAudioDone" });
          return;
        case "interrupted":
          agentSays({ type: "UserStartedSpeaking" });
          return;
        case "toolCall": {
          const call = payload as ToolCallPayload;
          agentSays({
            type: "FunctionCallRequest",
            functions: [
              {
                id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.args),
                client_side: true
              }
            ]
          });
          return;
        }
        case "fatalError":
          // Refused settings arrive before `SettingsApplied`; the socket is
          // open by then, since the settings were sent over it.
          socket.emit("open");
          agentSays({ type: "Error", description: "settings refused", code: "INVALID_SETTINGS" });
      }
    },
    turnSettleMs: DEEPGRAM_TURN_QUIET_MS,
    toolResponses: () =>
      socket.sent.flatMap((m) => {
        const msg = m as { type: string; id: string; name: string; content: ToolResult };
        return msg.type === "FunctionCallResponse"
          ? [{ id: msg.id, name: msg.name, result: msg.content }]
          : [];
      })
  };
  return { name: "deepgram", provider, wire };
}

import { afterEach, expect } from "vitest";
import type {
  AudioFrame,
  RealtimeProviderError,
  RealtimeSession,
  ToolCallRequest,
  ToolDeclaration,
  TranscriptEvent
} from "@parley/core";
import { createDeepgramRealtimeProvider } from "../src/index.js";

/** Every client->server message type the provider must NEVER send.
 * `InjectAgentMessage` is spoken verbatim by Deepgram's TTS, bypassing the
 * LLM, so the callee would hear whatever it carried; the `Update*` family
 * would re-instruct the agent mid-session. */
export const FORBIDDEN_CLIENT_MESSAGES = [
  "InjectAgentMessage",
  "UpdatePrompt",
  "UpdateThink",
  "UpdateSpeak",
  "UpdateListen"
] as const;

/** Every fake socket created in the current test file. */
const allSockets: FakeAgentSocket[] = [];

// Registered by importing this module, so it runs after every test in every
// file that uses the fake socket: whatever a test drove, no socket ever
// carried a message Deepgram would speak verbatim or treat as a mid-session
// re-instruction.
afterEach(() => {
  for (const socket of allSockets) {
    const types = socket.sent.map((m) => m.type);
    for (const forbidden of FORBIDDEN_CLIENT_MESSAGES) expect(types).not.toContain(forbidden);
  }
  allSockets.length = 0;
});

/** A fake Deepgram Voice Agent socket, in the shape `AgentSocket` needs:
 * `.on`/`.send`/`.close`, plus test-only helpers to drive it from the
 * agent's side (`emitAgent` for JSON control messages, `emitBinary` for raw
 * mu-law audio frames) and to inspect what the provider sent (`sent`).
 *
 * Every outbound `send()` is recorded as a plain JSON-shaped record —
 * including audio frames, represented as a synthetic `{ type: "AudioFrame",
 * byteLength }` marker rather than the raw Buffer — so `sent`'s element type
 * stays `Record<string, unknown>` and every assertion in provider.test.ts
 * (`m.type === "..."`, `JSON.stringify(m)`) type-checks without `any`. */
export class FakeAgentSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private readonly handlers: Record<string, ((...a: unknown[]) => void)[]> = {};

  constructor() {
    allSockets.push(this);
  }

  on(event: string, fn: (...a: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(fn);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) h(...args);
  }

  send(data: Buffer | string): void {
    if (typeof data === "string") {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
      return;
    }
    this.sent.push({ type: "AudioFrame", byteLength: data.length });
  }

  close(): void {
    this.closed = true;
    this.emit("close", 1000, Buffer.from("done"));
  }

  /** Simulate the socket completing its handshake, as a real `ws` client
   * fires once TCP/TLS is up. `connectProvider` calls this for you. */
  open(): void {
    this.emit("open");
  }

  /** Simulate an inbound JSON control message from the Deepgram agent —
   * ConversationText, UserStartedSpeaking, FunctionCallRequest, etc. */
  emitAgent(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }

  /** Simulate an inbound binary (mu-law@8000) audio frame from the agent. */
  emitBinary(data: Buffer): void {
    this.emit("message", data, true);
  }

  /** Simulate the underlying transport reporting a socket error — a real
   * `ws` client fires this both before the session is ready (it never comes
   * up) and after (a transient mid-session fault). Which one happened is
   * exactly what `onError`'s `fatal` flag is meant to distinguish; callers
   * drive that distinction by calling this before or after `SettingsApplied`. */
  emitError(err: Error): void {
    this.emit("error", err);
  }
}

export interface ConnectProviderOptions {
  systemInstruction?: string;
  onInterrupted?: () => void;
  onAudio?: (frame: AudioFrame) => void;
  onTranscript?: (event: TranscriptEvent) => void;
  onError?: (error: RealtimeProviderError) => void;
  onTurnComplete?: () => void;
  onDiagnostic?: (message: string) => void;
  onToolCall?: (call: ToolCallRequest) => void;
  onClose?: (reason: string) => void;
  speakerRole?: "caller" | "participant";
  keyterms?: readonly string[];
  tools?: readonly ToolDeclaration[];
  settingsTimeoutMs?: number;
  speed?: number;
}

/** Start a connect against `socket` WITHOUT driving any handshake step, so a
 * test can deliver `open` / `SettingsApplied` / `Error` itself. The key is
 * the literal `"test-key"`, never a real credential. */
export function startConnect(
  socket: FakeAgentSocket,
  opts: ConnectProviderOptions = {}
): Promise<RealtimeSession> {
  const provider = createDeepgramRealtimeProvider({
    apiKey: "test-key",
    wsFactory: () => socket as never,
    ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
    ...(opts.settingsTimeoutMs !== undefined ? { settingsTimeoutMs: opts.settingsTimeoutMs } : {})
  });
  return provider.connect({
    model: "test-model",
    systemInstruction: opts.systemInstruction ?? "You are a test persona.",
    responseModality: "audio",
    speakerRole: opts.speakerRole,
    ...(opts.keyterms ? { keyterms: opts.keyterms } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    callbacks: {
      onAudio: opts.onAudio ?? (() => {}),
      onInterrupted: opts.onInterrupted ?? (() => {}),
      onTranscript: opts.onTranscript ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      onClose: opts.onClose ?? (() => {}),
      ...(opts.onTurnComplete ? { onTurnComplete: opts.onTurnComplete } : {}),
      ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
      ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {})
    }
  });
}

/** Connect, open the fake socket, acknowledge the Settings the way the real
 * agent does (`SettingsApplied`), and return the resulting session. */
export async function connectProvider(
  socket: FakeAgentSocket,
  opts: ConnectProviderOptions = {}
): Promise<RealtimeSession> {
  const promise = startConnect(socket, opts);
  socket.open();
  socket.emitAgent({ type: "SettingsApplied" });
  return promise;
}

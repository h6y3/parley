import type {
  AudioFrame,
  RealtimeProviderError,
  RealtimeSession,
  TranscriptEvent
} from "@parley/core";
import { createDeepgramRealtimeProvider } from "../src/index.js";

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
  private readonly handlers: Record<string, ((...a: unknown[]) => void)[]> = {};

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
   * `ws` client fires this both before the handshake completes (the socket
   * never opens) and after (a transient mid-session fault). Which one
   * happened is exactly what `onError`'s `fatal` flag is meant to
   * distinguish; callers drive that distinction by calling this either
   * before or after `open()`. */
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
  speakerRole?: "caller" | "participant";
}

/** Build a `createDeepgramRealtimeProvider` wired to `socket` via an
 * injected `wsFactory` (literal `"test-key"`, never a real credential),
 * connect it, open the fake socket, and return the resulting session. */
export async function connectProvider(
  socket: FakeAgentSocket,
  opts: ConnectProviderOptions = {}
): Promise<RealtimeSession> {
  const provider = createDeepgramRealtimeProvider({
    apiKey: "test-key",
    wsFactory: () => socket as never
  });
  const promise = provider.connect({
    model: "test-model",
    systemInstruction: opts.systemInstruction ?? "You are a test persona.",
    responseModality: "audio",
    speakerRole: opts.speakerRole,
    callbacks: {
      onAudio: opts.onAudio ?? (() => {}),
      onInterrupted: opts.onInterrupted ?? (() => {}),
      onTranscript: opts.onTranscript ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      onClose: () => {}
    }
  });
  socket.open();
  return promise;
}

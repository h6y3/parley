import { describe, expect, it } from "vitest";
import type { RealtimeProviderError } from "@parley/core";
import { createDeepgramRealtimeProvider } from "../src/index.js";
import { FakeAgentSocket, connectProvider } from "./helpers.js";

/** `onError`'s `fatal` flag diverges from `GeminiRealtimeProvider`, which
 * reports `fatal: true` unconditionally. This provider instead reports
 * `fatal: !ready`: a socket error before the handshake completes means the
 * session never opened and there is nothing left to recover — fatal. A
 * socket error after the handshake is a transient fault on an otherwise
 * live session, which is a materially different situation from "the
 * connection never came up" and is reported as non-fatal.
 *
 * This is a deliberate, disclosed divergence from the provider this task
 * mirrors (see the task report), not an oversight — these tests cover both
 * branches so a future edit that collapses them back to Gemini's
 * unconditional `true`, or flips the condition, is caught rather than
 * silently shipped. */
describe("onError fatal flag", () => {
  it("reports fatal:true for an error before the socket ever opens, and connect() rejects", async () => {
    const socket = new FakeAgentSocket();
    const provider = createDeepgramRealtimeProvider({
      apiKey: "test-key",
      wsFactory: () => socket as never
    });
    const events: RealtimeProviderError[] = [];

    const connectPromise = provider.connect({
      model: "test-model",
      systemInstruction: "You are a test persona.",
      responseModality: "audio",
      callbacks: {
        onAudio: () => {},
        onInterrupted: () => {},
        onTranscript: () => {},
        onError: (e) => events.push(e),
        onClose: () => {}
      }
    });

    // Never call socket.open() — the handshake never completes.
    socket.emitError(new Error("handshake refused"));

    await expect(connectPromise).rejects.toThrow(/agent socket failed to open/);
    expect(events).toEqual([
      { code: "deepgram_agent_error", message: "handshake refused", fatal: true }
    ]);
  });

  it("reports fatal:false for an error after the socket has already opened", async () => {
    const socket = new FakeAgentSocket();
    const events: RealtimeProviderError[] = [];

    // connectProvider opens the socket for us and awaits the resolved
    // session, so by the time we emit the error the handshake is done.
    await connectProvider(socket, { onError: (e) => events.push(e) });

    socket.emitError(new Error("transient read error"));

    expect(events).toEqual([
      { code: "deepgram_agent_error", message: "transient read error", fatal: false }
    ]);
  });
});

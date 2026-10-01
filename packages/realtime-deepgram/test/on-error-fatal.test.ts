import { describe, expect, it } from "vitest";
import type { RealtimeProviderError } from "@parley/core";
import { createDeepgramRealtimeProvider } from "../src/index.js";
import { FakeAgentSocket, connectProvider, startConnect } from "./helpers.js";

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

  /** The settings timeout has already failed the handshake and rejected
   * connect. A vendor `Error` arriving on the dying socket after that has no
   * session to be fatal to — the rejection was the whole signal, exactly as
   * the socket-error handler already treats its own echo. */
  it("reports nothing for a vendor Error after the handshake has already failed", async () => {
    const socket = new FakeAgentSocket();
    const events: RealtimeProviderError[] = [];
    const connecting = startConnect(socket, {
      onError: (e) => events.push(e),
      settingsTimeoutMs: 1
    });
    socket.open();
    await expect(connecting).rejects.toThrow(/no SettingsApplied/);

    socket.emitAgent({ type: "Error", description: "late", code: "LATE" });

    expect(events).toEqual([]);
  });

  it("reports fatal:false for an error after the socket has already opened", async () => {
    const socket = new FakeAgentSocket();
    const events: RealtimeProviderError[] = [];

    // connectProvider opens the socket, delivers SettingsApplied and awaits
    // the resolved session, so by the time we emit the error it is ready.
    await connectProvider(socket, { onError: (e) => events.push(e) });

    socket.emitError(new Error("transient read error"));

    expect(events).toEqual([
      { code: "deepgram_agent_error", message: "transient read error", fatal: false }
    ]);
  });
});

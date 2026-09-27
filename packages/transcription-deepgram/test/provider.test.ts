import { describe, expect, it, vi } from "vitest";
import type { TranscriptEvent } from "@parley/core";
import { MULAW_8K } from "@parley/core";
import { createDeepgramTranscriptionProvider, FLUSH_RESULT_TIMEOUT_MS } from "../src/index.js";

class FakeSocket {
  readonly sent: unknown[] = [];
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  on(event: string, fn: (...a: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close", 1000, Buffer.from("done"));
  }
}

const connectWith = async (socket: FakeSocket, params: Partial<{ offsetMs: number }> = {}) => {
  const events: TranscriptEvent[] = [];
  const provider = createDeepgramTranscriptionProvider({
    apiKey: "test-key",
    wsFactory: () => socket as never
  });
  const promise = provider.connect({
    encoding: MULAW_8K,
    channels: 1,
    interimResults: true,
    wordTimestamps: true,
    diarize: false,
    offsetMs: params.offsetMs ?? 0,
    callbacks: { onTranscript: (e) => events.push(e), onError: () => {}, onClose: () => {} }
  });
  socket.emit("open");
  return { session: await promise, events, provider };
};

describe("DeepgramTranscriptionProvider", () => {
  it("declares mono audio ingress and accepts mulaw@8000 first", () => {
    const provider = createDeepgramTranscriptionProvider({ apiKey: "k" });
    expect(provider.ingress).toEqual({ audio: true, channels: "mono" });
    expect(provider.accepts[0]).toEqual(MULAW_8K);
  });

  it("emits participant events with a segmentId derived from segment start", async () => {
    const socket = new FakeSocket();
    const { events } = await connectWith(socket);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 1.25,
          duration: 0.5,
          is_final: false,
          channel: { alternatives: [{ transcript: "the quick", words: [] }] }
        })
      )
    );
    expect(events[0]).toMatchObject({
      speaker: "participant",
      segmentId: "1250",
      startMs: 1250,
      endMs: 1750,
      text: "the quick",
      isFinal: false
    });
    expect(events[0]?.speakerId).toBeUndefined();
  });

  it("adds offsetMs to every timestamp so a reconnect does not restart the clock", async () => {
    const socket = new FakeSocket();
    const { events } = await connectWith(socket, { offsetMs: 600_000 });
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 2,
          duration: 1,
          is_final: true,
          channel: { alternatives: [{ transcript: "hello", words: [] }] }
        })
      )
    );
    expect(events[0]).toMatchObject({ segmentId: "602000", startMs: 602_000, endMs: 603_000 });
  });

  it("drops frames while not ready rather than buffering them", async () => {
    const socket = new FakeSocket();
    const { session } = await connectWith(socket);
    expect(session.ready).toBe(true);
    socket.emit("close", 1006, Buffer.from("gone"));
    expect(session.ready).toBe(false);
    const before = socket.sent.length;
    const droppedFrame = Buffer.alloc(160, 1);
    session.sendAudio({ encoding: MULAW_8K, data: droppedFrame });
    expect(socket.sent.length).toBe(before);

    // Restoring readiness must NOT replay what was dropped while not ready —
    // proving the frame above was discarded outright, not queued for later
    // delivery. An implementation that buffered and flushed on reconnect
    // would pass the assertion above unchanged and only be caught here.
    socket.emit("open");
    expect(session.ready).toBe(true);
    const newFrame = Buffer.alloc(160, 2);
    session.sendAudio({ encoding: MULAW_8K, data: newFrame });
    expect(socket.sent).toEqual([newFrame]);
    expect(socket.sent).not.toContain(droppedFrame);
  });

  it("skips empty transcripts entirely", async () => {
    const socket = new FakeSocket();
    const { events } = await connectWith(socket);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 0,
          duration: 0,
          is_final: false,
          channel: { alternatives: [{ transcript: "", words: [] }] }
        })
      )
    );
    expect(events).toHaveLength(0);
  });

  it("never puts the api key in an error message", async () => {
    const provider = createDeepgramTranscriptionProvider({
      apiKey: "super-secret",
      wsFactory: () => {
        throw new Error("connect refused");
      }
    });
    // Assert on the caught message directly. `.rejects.not.toThrow(pattern)`
    // reads as "does not reject", which is the opposite of what is meant here:
    // it MUST reject, and the reason must not quote the credential.
    let caught: unknown;
    try {
      await provider.connect({
        encoding: MULAW_8K,
        channels: 1,
        interimResults: true,
        wordTimestamps: true,
        diarize: false,
        offsetMs: 0,
        callbacks: { onTranscript: vi.fn(), onError: vi.fn(), onClose: vi.fn() }
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).not.toContain("super-secret");
  });
});

/** `CallSession.endCall` flushes the listening plane BEFORE it closes anything,
 * so the meeting's last words land in the transcript rather than dying with
 * the socket carrying them. That only works if `flush()` waits for the answer:
 * sending `Finalize` and resolving is resolving on "the request was written to
 * a socket". */
describe("flush waits for the result Finalize asks for", () => {
  it("does not resolve until the Results message arrives, and delivers it first", async () => {
    const socket = new FakeSocket();
    const { session, events } = await connectWith(socket);

    let settled = false;
    const flushing = session.flush().then(() => {
      settled = true;
    });
    // The marker went out...
    expect(socket.sent.map(String)).toContain(JSON.stringify({ type: "Finalize" }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    // ...and nothing has come back, so the hangup must still be waiting.
    expect(settled).toBe(false);
    expect(events).toHaveLength(0);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 300,
          duration: 3,
          is_final: true,
          channel: { alternatives: [{ transcript: "one last thing before we go", words: [] }] }
        })
      )
    );
    await flushing;
    expect(settled).toBe(true);
    // Delivered BEFORE the flush resolved, not after it.
    expect(events.map((e) => e.text)).toEqual(["one last thing before we go"]);
  });

  it("does not release the wait on an interim result — only on the final that follows", async () => {
    const socket = new FakeSocket();
    const { session, events } = await connectWith(socket);

    let settled = false;
    const flushing = session.flush().then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // An interim already in flight when Finalize was sent: non-empty text,
    // is_final: false. Must not release the waiter — the finalized last
    // utterance has not arrived yet.
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 300,
          duration: 1,
          is_final: false,
          channel: { alternatives: [{ transcript: "one last", words: [] }] }
        })
      )
    );
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(settled).toBe(false);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 300,
          duration: 3,
          is_final: true,
          channel: { alternatives: [{ transcript: "one last thing before we go", words: [] }] }
        })
      )
    );
    await flushing;
    expect(settled).toBe(true);
    expect(events.map((e) => e.text)).toEqual(["one last", "one last thing before we go"]);
  });

  it("gives up after a bounded wait rather than holding a finished call open", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const { session } = await connectWith(socket);
      let settled = false;
      const flushing = session.flush().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(FLUSH_RESULT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await flushing;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the wait when the socket closes, which can never answer a Finalize", async () => {
    const socket = new FakeSocket();
    const { session } = await connectWith(socket);
    const flushing = session.flush();
    socket.close();
    await expect(flushing).resolves.toBeUndefined();
  });
});

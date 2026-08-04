import { describe, expect, it, vi } from "vitest";
import type {
  AudioFrame,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeSession,
  TranscriptEvent
} from "@parley/core";
import { runAudioScript } from "../src/audio-runner.js";

function makeFakeProvider(): {
  provider: RealtimeProvider;
  emit: (event: TranscriptEvent) => void;
  sendOpeningTrigger: ReturnType<typeof vi.fn>;
  sendAudio: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sendOpeningTrigger = vi.fn();
  const sendAudio = vi.fn();
  const close = vi.fn(async () => {});
  let capturedParams: RealtimeConnectParams | undefined;

  const provider: RealtimeProvider = {
    name: "fake",
    connect: async (params: RealtimeConnectParams): Promise<RealtimeSession> => {
      capturedParams = params;
      return { sendOpeningTrigger, sendAudio, notifyActivityEnd: () => {}, close };
    }
  };

  return {
    provider,
    emit: (event: TranscriptEvent) => capturedParams?.callbacks.onTranscript(event),
    sendOpeningTrigger,
    sendAudio,
    close
  };
}

function makeThrowingProvider(close: ReturnType<typeof vi.fn>): RealtimeProvider {
  return {
    name: "fake-throwing",
    connect: async (): Promise<RealtimeSession> => ({
      sendOpeningTrigger: () => {},
      sendAudio: () => {
        throw new Error("boom");
      },
      notifyActivityEnd: () => {},
      close
    })
  };
}

function makeOpeningTriggerThrowingProvider(close: ReturnType<typeof vi.fn>): RealtimeProvider {
  return {
    name: "fake-opening-throwing",
    connect: async (): Promise<RealtimeSession> => ({
      sendOpeningTrigger: () => {
        throw new Error("boom-opening");
      },
      sendAudio: () => {},
      notifyActivityEnd: () => {},
      close
    })
  };
}

describe("runAudioScript", () => {
  it("sends the opening trigger, streams each turn's frames, and resolves early on isFinal", async () => {
    vi.useFakeTimers();
    const fake = makeFakeProvider();
    const frame: AudioFrame = { encoding: "pcm16k", data: Buffer.from([9]) };

    const resultPromise = runAudioScript({
      provider: fake.provider,
      model: "gemini-3.1-flash-live-preview",
      systemInstruction: "test persona",
      openingTrigger: "Begin the call naturally now.",
      turns: [{ label: "derail-1", frames: [frame] }],
      turnTimeoutMs: 5000
    });

    // Let the opening turn settle immediately via an isFinal transcript event,
    // rather than waiting out the full 5000ms timeout.
    await vi.advanceTimersByTimeAsync(0);
    fake.emit({ speaker: "model", text: "Hi there.", isFinal: true });
    await vi.advanceTimersByTimeAsync(0);

    fake.emit({ speaker: "model", text: "Sure, one moment.", isFinal: true });
    await vi.advanceTimersByTimeAsync(0);

    const result = await resultPromise;
    vi.useRealTimers();

    expect(fake.sendOpeningTrigger).toHaveBeenCalledWith("Begin the call naturally now.");
    expect(fake.sendAudio).toHaveBeenCalledWith(frame);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(result.turns).toEqual([
      { label: "opening", transcript: [{ speaker: "model", text: "Hi there.", isFinal: true }] },
      { label: "derail-1", transcript: [{ speaker: "model", text: "Sure, one moment.", isFinal: true }] }
    ]);
    expect(result.fullTranscript).toHaveLength(2);
  });

  it("falls back to the timeout when isFinal never arrives", async () => {
    vi.useFakeTimers();
    const fake = makeFakeProvider();

    const resultPromise = runAudioScript({
      provider: fake.provider,
      model: "gemini-3.1-flash-live-preview",
      systemInstruction: "test persona",
      openingTrigger: "Begin the call naturally now.",
      turns: [],
      turnTimeoutMs: 3000
    });

    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.turns).toEqual([{ label: "opening", transcript: [] }]);
  });
});

describe("runAudioScript resource safety", () => {
  it("closes the session even when a turn callback throws", async () => {
    const close = vi.fn(async () => {});
    const provider = makeThrowingProvider(close); // fake whose sendAudio throws on the scripted turn
    await expect(
      runAudioScript({
        provider,
        model: "m",
        systemInstruction: "s",
        openingTrigger: "go",
        turns: [{ label: "boom", frames: [{ encoding: "pcm16k", data: Buffer.from([1]) }] }],
        // Real (non-fake) timers here: keep the opening turn's timeout tiny so
        // this test resolves quickly instead of waiting out the 15s default.
        turnTimeoutMs: 10
      })
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the session even when sendOpeningTrigger throws synchronously", async () => {
    const close = vi.fn(async () => {});
    const provider = makeOpeningTriggerThrowingProvider(close); // fake whose sendOpeningTrigger throws
    await expect(
      runAudioScript({
        provider,
        model: "m",
        systemInstruction: "s",
        openingTrigger: "go",
        turns: [],
        // Real (non-fake) timers here: keep the opening turn's timeout tiny so
        // this test resolves quickly instead of waiting out the 15s default.
        turnTimeoutMs: 10
      })
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
});

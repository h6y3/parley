import { describe, expect, it, vi } from "vitest";
import {
  MEETING_CONNECTED_CUE,
  MEETING_OPENING_TRIGGER,
  MULAW_8K,
  OPENING_TRIGGER,
  PCM_16K,
  PCM_24K
} from "@parley/core";
import type {
  AudioFrame,
  OpeningDelivery,
  RealtimeConnectParams,
  RealtimeProvider,
  RealtimeSession,
  TranscriptEvent
} from "@parley/core";
import { runAudioScript } from "../src/audio-runner.js";

function makeFakeProvider(openingDelivery: OpeningDelivery = "turn"): {
  provider: RealtimeProvider;
  emit: (event: TranscriptEvent) => void;
  /** The provider's own turn end (Gemini `turnComplete`, Deepgram
   * `AgentAudioDone`). */
  turnComplete: () => void;
  systemInstruction: () => string | undefined;
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
    audio: { accepts: [PCM_16K], emits: PCM_24K },
    openingDelivery,
    continuesAfterToolResponse: false,
    connect: async (params: RealtimeConnectParams): Promise<RealtimeSession> => {
      capturedParams = params;
      return {
        sendOpeningTrigger,
        sendAudio,
        notifyActivityEnd: () => {},
        sendToolResponse: () => {},
        close
      };
    }
  };

  return {
    provider,
    emit: (event: TranscriptEvent) => capturedParams?.callbacks.onTranscript(event),
    turnComplete: () => capturedParams?.callbacks.onTurnComplete?.(),
    systemInstruction: () => capturedParams?.systemInstruction,
    sendOpeningTrigger,
    sendAudio,
    close
  };
}

function makeThrowingProvider(close: ReturnType<typeof vi.fn>): RealtimeProvider {
  return {
    name: "fake-throwing",
    audio: { accepts: [PCM_16K], emits: PCM_24K },
    openingDelivery: "turn",
    continuesAfterToolResponse: false,
    connect: async (): Promise<RealtimeSession> => ({
      sendOpeningTrigger: () => {},
      sendAudio: () => {
        throw new Error("boom");
      },
      notifyActivityEnd: () => {},
      sendToolResponse: () => {},
      close
    })
  };
}

function makeOpeningTriggerThrowingProvider(close: ReturnType<typeof vi.fn>): RealtimeProvider {
  return {
    name: "fake-opening-throwing",
    audio: { accepts: [PCM_16K], emits: PCM_24K },
    openingDelivery: "turn",
    continuesAfterToolResponse: false,
    connect: async (): Promise<RealtimeSession> => ({
      sendOpeningTrigger: () => {
        throw new Error("boom-opening");
      },
      sendAudio: () => {},
      notifyActivityEnd: () => {},
      sendToolResponse: () => {},
      close
    })
  };
}

describe("runAudioScript", () => {
  it("sends the opening trigger, streams each turn's frames, and resolves early on the model's turn end", async () => {
    vi.useFakeTimers();
    const fake = makeFakeProvider();
    const frame: AudioFrame = { encoding: PCM_16K, data: Buffer.from([9]) };

    const resultPromise = runAudioScript({
      provider: fake.provider,
      model: "gemini-3.1-flash-live-preview",
      systemInstruction: "test persona",
      turns: [{ label: "derail-1", frames: [frame] }],
      turnTimeoutMs: 5000
    });

    // Let the opening turn end immediately via the provider's turn end,
    // rather than waiting out the full 5000ms timeout.
    await vi.advanceTimersByTimeAsync(0);
    fake.emit({ speaker: "model", text: "Hi there.", isFinal: true });
    fake.turnComplete();
    await vi.advanceTimersByTimeAsync(0);

    fake.emit({ speaker: "model", text: "Sure, one moment.", isFinal: true });
    fake.turnComplete();
    await vi.advanceTimersByTimeAsync(0);

    const result = await resultPromise;
    vi.useRealTimers();

    // Planned by `planOpening`, as a real call's is — no longer caller text.
    expect(fake.sendOpeningTrigger).toHaveBeenCalledWith(OPENING_TRIGGER);
    expect(fake.systemInstruction()).toBe("test persona");
    expect(fake.sendAudio).toHaveBeenCalledWith(frame);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(result.turns).toMatchObject([
      { label: "opening", transcript: [{ speaker: "model", text: "Hi there.", isFinal: true }] },
      {
        label: "derail-1",
        transcript: [{ speaker: "model", text: "Sure, one moment.", isFinal: true }]
      }
    ]);
    expect(result.fullTranscript).toHaveLength(2);
  });

  it("falls back to the timeout when the turn never ends", async () => {
    vi.useFakeTimers();
    const fake = makeFakeProvider();

    const resultPromise = runAudioScript({
      provider: fake.provider,
      model: "gemini-3.1-flash-live-preview",
      systemInstruction: "test persona",
      turns: [],
      turnTimeoutMs: 3000
    });

    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.turns).toMatchObject([{ label: "opening", transcript: [] }]);
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
        turns: [{ label: "boom", frames: [{ encoding: PCM_16K, data: Buffer.from([1]) }] }],
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
        turns: [],
        // Real (non-fake) timers here: keep the opening turn's timeout tiny so
        // this test resolves quickly instead of waiting out the 15s default.
        turnTimeoutMs: 10
      })
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("runAudioScript audio contract", () => {
  it("adapts fixture frames to what the provider declares it accepts", async () => {
    const sent: AudioFrame[] = [];
    const provider: RealtimeProvider = {
      name: "fake-mulaw",
      audio: { accepts: [MULAW_8K], emits: MULAW_8K },
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      connect: async (): Promise<RealtimeSession> => ({
        sendOpeningTrigger: () => {},
        sendAudio: (frame) => sent.push(frame),
        notifyActivityEnd: () => {},
        sendToolResponse: () => {},
        close: async () => {}
      })
    };
    const pcm = Buffer.alloc(960); // 30ms of 16 kHz PCM16 silence
    await runAudioScript({
      provider,
      model: "m",
      systemInstruction: "s",
      turns: [{ label: "t", frames: [{ encoding: PCM_16K, data: pcm }] }],
      turnTimeoutMs: 1
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.encoding).toEqual(MULAW_8K);
    // 16 kHz PCM16 -> 8 kHz mu-law is 4 bytes in, 1 byte out.
    expect(sent[0]?.data.length).toBe(pcm.length / 4);
  });
});

/** The reliability gate runs the provider it is given, so it has to put the
 * opening where that provider takes it — through the same `planOpening` a
 * real call uses. Sent the long trigger as a user turn, a `"prompt"` provider
 * (Deepgram) would hear it as the callee speaking, and a run would measure
 * that artefact rather than the model. */
describe("runAudioScript opening delivery", () => {
  it('"prompt", two-party: nothing is sent, the prompt carries the trigger, and nothing waits on an opening reply', async () => {
    vi.useFakeTimers();
    const fake = makeFakeProvider("prompt");
    const result = await runAudioScript({
      provider: fake.provider,
      model: "m",
      systemInstruction: "test persona",
      turns: [],
      turnTimeoutMs: 5000
    });
    vi.useRealTimers();

    expect(fake.sendOpeningTrigger).not.toHaveBeenCalled();
    expect(fake.systemInstruction()).toBe(`test persona\n\n${OPENING_TRIGGER}`);
    // No timer was advanced: with no opening sent there is no reply to wait for.
    expect(result.turns).toMatchObject([{ label: "opening", transcript: [] }]);
  });

  it('"prompt", meeting: sends only the connected cue, and the prompt carries the meeting trigger', async () => {
    vi.useFakeTimers();
    const fake = makeFakeProvider("prompt");
    const running = runAudioScript({
      provider: fake.provider,
      model: "m",
      systemInstruction: "test persona",
      meeting: true,
      turns: [],
      turnTimeoutMs: 1000
    });
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    vi.useRealTimers();

    expect(fake.sendOpeningTrigger).toHaveBeenCalledTimes(1);
    expect(fake.sendOpeningTrigger).toHaveBeenCalledWith(MEETING_CONNECTED_CUE);
    expect(fake.systemInstruction()).toBe(`test persona\n\n${MEETING_OPENING_TRIGGER}`);
  });
});

/** A turn is the MODEL's: it ends on the provider's own turn end, never on a
 * transcript of the far end. Deepgram marks every `ConversationText` final,
 * the caller's included, so a runner that ended on any final closed the
 * session the moment the derail line was transcribed — 20 of 20 billed runs
 * per model had no reply to score. */
describe("runAudioScript turn end", () => {
  it("does not end a turn on the caller's final transcript, only on the model's turn end", async () => {
    vi.useFakeTimers();
    const fake = makeFakeProvider("prompt"); // Deepgram-shaped: no opening turn
    const frame: AudioFrame = { encoding: PCM_16K, data: Buffer.from([9]) };
    const callerLine: TranscriptEvent = {
      speaker: "caller",
      text: "Hold on. Am I talking to a real person?",
      isFinal: true
    };
    const reply: TranscriptEvent = {
      speaker: "model",
      text: "I'm Alex Rivera's AI assistant, calling about the dentist appointment.",
      isFinal: true
    };
    let done = false;
    const running = runAudioScript({
      provider: fake.provider,
      model: "m",
      systemInstruction: "test persona",
      turns: [{ label: "are-you-an-ai", frames: [frame] }],
      turnTimeoutMs: 5000
    }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(0);

    // Deepgram's transcription of the fixture audio: final, and the caller's.
    fake.emit(callerLine);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(fake.close).not.toHaveBeenCalled();

    // Deepgram's `ConversationText(assistant)` arrives before the audio it
    // describes has played out; the turn is not over until `AgentAudioDone`.
    fake.emit(reply);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);

    fake.turnComplete();
    const result = await running;
    vi.useRealTimers();

    expect(fake.close).toHaveBeenCalledOnce();
    expect(result.turns).toMatchObject([
      { label: "opening", transcript: [] },
      { label: "are-you-an-ai", transcript: [callerLine, reply] }
    ]);
  });
});

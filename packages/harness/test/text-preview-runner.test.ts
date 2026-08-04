import { describe, expect, it, vi } from "vitest";
import { runTextPreview } from "../src/text-preview-runner.js";

describe("runTextPreview", () => {
  it("sends the opening trigger, then each user turn in order, over sendRealtimeInput({text})", async () => {
    vi.useFakeTimers();
    const sendRealtimeInput = vi.fn();
    const close = vi.fn();
    let capturedCallbacks: { onmessage: (m: unknown) => void; onerror: (e: unknown) => void } | undefined;

    const fakeGenAIFactory = () =>
      ({
        live: {
          connect: vi.fn(async (params: { callbacks: typeof capturedCallbacks }) => {
            capturedCallbacks = params.callbacks;
            return { sendRealtimeInput, close };
          })
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

    const resultPromise = runTextPreview({
      apiKey: "fake",
      systemInstruction: "test persona",
      openingTrigger: "Begin the call naturally now.",
      userTurns: ["Aren't you calling about the garage door for Alex?"],
      genAIFactory: fakeGenAIFactory
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sendRealtimeInput).toHaveBeenCalledWith({ text: "Begin the call naturally now." });

    capturedCallbacks?.onmessage({ serverContent: { outputTranscription: { text: "Hi, " } } });
    capturedCallbacks?.onmessage({ serverContent: { outputTranscription: { text: "how can I help?" }, turnComplete: true } });
    await vi.advanceTimersByTimeAsync(1200);

    expect(sendRealtimeInput).toHaveBeenCalledWith({ text: "Aren't you calling about the garage door for Alex?" });
    capturedCallbacks?.onmessage({
      serverContent: { outputTranscription: { text: "No, this call is about your plumbing appointment." }, turnComplete: true }
    });
    await vi.advanceTimersByTimeAsync(1200);

    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.turns).toEqual([
      { label: "opening", userText: undefined, responseText: "Hi, how can I help?" },
      {
        label: "turn-1",
        userText: "Aren't you calling about the garage door for Alex?",
        responseText: "No, this call is about your plumbing appointment."
      }
    ]);
    expect(result.fullText).toBe("Hi, how can I help?No, this call is about your plumbing appointment.");
    expect(close).toHaveBeenCalledOnce();
  });
});

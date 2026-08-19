import { describe, expect, it, vi } from "vitest";
import type { RealtimeConnectParams, RealtimeSessionCallbacks } from "@parley/core";
import { DEFAULT_GEMINI_MODEL, GeminiRealtimeProvider } from "../src/gemini-realtime-provider.js";

function makeCallbacks(): RealtimeSessionCallbacks & {
  onAudio: ReturnType<typeof vi.fn>;
  onInterrupted: ReturnType<typeof vi.fn>;
  onTranscript: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  return {
    onAudio: vi.fn(),
    onInterrupted: vi.fn(),
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn()
  };
}

function makeConnectParams(callbacks: RealtimeSessionCallbacks): RealtimeConnectParams {
  return {
    model: DEFAULT_GEMINI_MODEL,
    systemInstruction: "You are a test persona with exactly one purpose.",
    responseModality: "audio",
    callbacks
  };
}

/** Connects a GeminiRealtimeProvider against a fake GoogleGenAI factory (same
 * shape as the inline fake used in the primary test below) and returns the
 * live session plus hooks for driving/observing it: `sendRealtimeInput` (the
 * fake session's spy), `emitMessage` (invokes the captured `onmessage`
 * callback as the SDK would), and `callbacks` (the full callbacks bundle,
 * pre-wired to `onTranscriptSink` when provided). */
async function connectWithFakeGenAI(onTranscriptSink?: (event: unknown) => void) {
  const sendRealtimeInput = vi.fn();
  const fakeSession = {
    sendRealtimeInput,
    close: vi.fn()
  };
  let capturedCallbacks:
    | {
        onmessage: (m: unknown) => void;
        onerror: (e: unknown) => void;
        onclose: (e: unknown) => void;
      }
    | undefined;
  const fakeGenAI = {
    live: {
      connect: vi.fn(
        async (params: { model: string; config: unknown; callbacks: typeof capturedCallbacks }) => {
          capturedCallbacks = params.callbacks;
          return fakeSession;
        }
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const provider = new GeminiRealtimeProvider({ apiKey: "fake" }, () => fakeGenAI);
  const callbacks = makeCallbacks();
  if (onTranscriptSink) {
    callbacks.onTranscript.mockImplementation(onTranscriptSink);
  }
  const session = await provider.connect(makeConnectParams(callbacks));

  return {
    session,
    sendRealtimeInput,
    callbacks,
    emitMessage: (message: unknown) => capturedCallbacks?.onmessage(message)
  };
}

describe("GeminiRealtimeProvider", () => {
  it("connects with the spec §4.5 session defaults and exposes a narrow session", async () => {
    const fakeSession = {
      sendRealtimeInput: vi.fn(),
      close: vi.fn()
    };
    let capturedConfig: unknown;
    let capturedCallbacks:
      | {
          onmessage: (m: unknown) => void;
          onerror: (e: unknown) => void;
          onclose: (e: unknown) => void;
        }
      | undefined;
    const fakeGenAI = {
      live: {
        connect: vi.fn(
          async (params: {
            model: string;
            config: unknown;
            callbacks: typeof capturedCallbacks;
          }) => {
            capturedConfig = params.config;
            capturedCallbacks = params.callbacks;
            return fakeSession;
          }
        )
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const provider = new GeminiRealtimeProvider({ apiKey: "fake" }, () => fakeGenAI);
    const callbacks = makeCallbacks();
    const session = await provider.connect(makeConnectParams(callbacks));

    expect(fakeGenAI.live.connect).toHaveBeenCalledOnce();
    expect(
      (capturedConfig as { realtimeInputConfig: { turnCoverage: string } }).realtimeInputConfig
        .turnCoverage
    ).toBe("TURN_INCLUDES_ONLY_ACTIVITY");
    expect(capturedConfig).toMatchObject({
      systemInstruction: "You are a test persona with exactly one purpose.",
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      // Voice is pinned by default (Aoede) so every call sounds like the same
      // assistant — without it Gemini randomizes male/female per session.
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } }
    });

    session.sendOpeningTrigger("Begin the call naturally now.");
    expect(fakeSession.sendRealtimeInput).toHaveBeenCalledWith({
      text: "Begin the call naturally now."
    });

    const audioFrame = { encoding: "pcm16k" as const, data: Buffer.from([1, 2, 3]) };
    session.sendAudio(audioFrame);
    expect(fakeSession.sendRealtimeInput).toHaveBeenCalledWith({
      audio: { data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "audio/pcm;rate=16000" }
    });

    await session.close();
    expect(fakeSession.close).toHaveBeenCalledOnce();

    // Drive the captured onmessage handler as the SDK would, and confirm translation.
    capturedCallbacks?.onmessage({
      serverContent: {
        inputTranscription: { text: "Caller here", finished: true },
        outputTranscription: { text: "Hello there", finished: false },
        modelTurn: {
          parts: [{ inlineData: { data: Buffer.from("audio-bytes").toString("base64") } }]
        },
        interrupted: true
      }
    });
    expect(callbacks.onTranscript).toHaveBeenCalledWith({
      speaker: "model",
      text: "Hello there",
      isFinal: false
    });
    expect(callbacks.onTranscript).toHaveBeenCalledWith({
      speaker: "caller",
      text: "Caller here",
      isFinal: true
    });
    expect(callbacks.onAudio).toHaveBeenCalledWith({
      encoding: "pcm24k",
      data: Buffer.from("audio-bytes")
    });
    expect(callbacks.onInterrupted).toHaveBeenCalledOnce();

    capturedCallbacks?.onmessage({ serverContent: { turnComplete: true } });
    expect(callbacks.onTranscript).toHaveBeenCalledWith({
      speaker: "model",
      text: "",
      isFinal: true
    });

    capturedCallbacks?.onerror({ error: new Error("boom") });
    expect(callbacks.onError).toHaveBeenCalledWith({
      code: "gemini_live_error",
      message: "boom",
      fatal: true
    });

    capturedCallbacks?.onclose({ code: 1000, reason: "done" });
    expect(callbacks.onClose).toHaveBeenCalledWith("code=1000 reason=done");
  });
});

describe("sendAudio input-encoding guard", () => {
  it("throws on a non-pcm16k frame", async () => {
    const { session } = await connectWithFakeGenAI();
    expect(() => session.sendAudio({ encoding: "mulaw8k", data: Buffer.from([0]) })).toThrow(
      /pcm16k/
    );
  });

  it("accepts a pcm16k frame", async () => {
    const { session, sendRealtimeInput } = await connectWithFakeGenAI();
    session.sendAudio({ encoding: "pcm16k", data: Buffer.from([1, 2]) });
    expect(sendRealtimeInput).toHaveBeenCalledWith({
      audio: { data: Buffer.from([1, 2]).toString("base64"), mimeType: "audio/pcm;rate=16000" }
    });
  });
});

describe("transcript final dedup", () => {
  it("emits one isFinal when a payload has both finished transcription and turnComplete", async () => {
    const events: Array<{ isFinal: boolean }> = [];
    const { emitMessage } = await connectWithFakeGenAI((event) =>
      events.push(event as { isFinal: boolean })
    );

    emitMessage({
      serverContent: { outputTranscription: { text: "done", finished: true }, turnComplete: true }
    });

    expect(events.filter((event) => event.isFinal)).toHaveLength(1);
  });

  it("still emits the turnComplete sentinel when no finished transcription precedes it", async () => {
    const events: Array<{ isFinal: boolean }> = [];
    const { emitMessage } = await connectWithFakeGenAI((event) =>
      events.push(event as { isFinal: boolean })
    );

    emitMessage({
      serverContent: { outputTranscription: { text: "still speaking", finished: false } }
    });
    emitMessage({ serverContent: { turnComplete: true } });

    expect(events.filter((event) => event.isFinal)).toHaveLength(1);
  });

  it("resets the per-turn flag so a second turn's finished transcription still dedups correctly", async () => {
    const events: Array<{ isFinal: boolean; text: string }> = [];
    const { emitMessage } = await connectWithFakeGenAI((event) =>
      events.push(event as { isFinal: boolean; text: string })
    );

    // Turn 1: finished transcription + turnComplete → one isFinal:true (from finished)
    emitMessage({
      serverContent: { outputTranscription: { text: "one", finished: true }, turnComplete: true }
    });
    expect(events.filter((e) => e.isFinal)).toHaveLength(1);

    // Turn 2: turnComplete ONLY (no transcription) → one isFinal:true (sentinel empty-text only)
    // If the per-turn flag were NOT reset after turn 1, this turnComplete would be suppressed
    // (flag still true → sentinel suppressed) and we'd remain at 1 isFinal total.
    emitMessage({
      serverContent: { turnComplete: true }
    });

    const finalEvents = events.filter((e) => e.isFinal);
    expect(finalEvents).toHaveLength(2);
    expect(finalEvents[1].text).toBe(""); // Turn 2's sentinel is empty-text
  });
});

/** Like connectWithFakeGenAI, but also captures the connect `config` and gives
 * the fake session a sendToolResponse spy — the two things the tool channel
 * needs to observe. */
async function connectForTools(extra: Partial<RealtimeConnectParams> = {}) {
  const sendToolResponse = vi.fn();
  const fakeSession = { sendRealtimeInput: vi.fn(), sendToolResponse, close: vi.fn() };
  let captured:
    { config: Record<string, unknown>; callbacks: { onmessage: (m: unknown) => void } } | undefined;
  const fakeGenAI = {
    live: {
      connect: vi.fn(
        async (params: {
          config: Record<string, unknown>;
          callbacks: { onmessage: (m: unknown) => void };
        }) => {
          captured = params;
          return fakeSession;
        }
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const provider = new GeminiRealtimeProvider({ apiKey: "fake" }, () => fakeGenAI);
  const callbacks = makeCallbacks();
  const session = await provider.connect({ ...makeConnectParams(callbacks), ...extra });
  return {
    session,
    sendToolResponse,
    callbacks,
    config: captured?.config ?? {},
    emitMessage: (m: unknown) => captured?.callbacks.onmessage(m)
  };
}

describe("tool channel", () => {
  it("declares tools on connect using parametersJsonSchema", async () => {
    const { config } = await connectForTools({
      tools: [
        {
          name: "press_digits",
          description: "d",
          parametersJsonSchema: { type: "object", properties: {} }
        }
      ]
    });
    const tools = config.tools as Array<{
      functionDeclarations: Array<{ name: string; parametersJsonSchema: unknown }>;
    }>;
    expect(tools[0].functionDeclarations[0].name).toBe("press_digits");
    expect(tools[0].functionDeclarations[0].parametersJsonSchema).toEqual({
      type: "object",
      properties: {}
    });
  });

  it("omits tools from the config entirely when none are passed", async () => {
    const { config } = await connectForTools();
    expect(config).not.toHaveProperty("tools");
  });

  it("omits tools from the config when passed an empty array", async () => {
    const { config } = await connectForTools({ tools: [] });
    expect(config).not.toHaveProperty("tools");
  });

  it("surfaces a server toolCall through onToolCall", async () => {
    const seen: unknown[] = [];
    const run = await connectForTools({
      callbacks: { ...makeCallbacks(), onToolCall: (c) => seen.push(c) }
    });
    run.emitMessage({
      toolCall: { functionCalls: [{ id: "c1", name: "press_digits", args: { digits: "1" } }] }
    });
    expect(seen).toEqual([{ id: "c1", name: "press_digits", args: { digits: "1" } }]);
  });

  it("ignores a tool call with no id — it could never be answered", async () => {
    const seen: unknown[] = [];
    const callbacks = makeCallbacks();
    const run = await connectForTools({
      callbacks: { ...callbacks, onToolCall: (c) => seen.push(c) }
    });
    run.emitMessage({ toolCall: { functionCalls: [{ name: "press_digits", args: {} }] } });
    expect(seen).toEqual([]);
  });

  it("still surfaces a tool call when the payload carries no serverContent", async () => {
    const seen: unknown[] = [];
    const callbacks = makeCallbacks();
    const run = await connectForTools({
      callbacks: { ...callbacks, onToolCall: (c) => seen.push(c) }
    });
    run.emitMessage({ toolCall: { functionCalls: [{ id: "c9", name: "end_call", args: {} }] } });
    expect(seen).toHaveLength(1);
  });

  it("sends a tool response echoing id and name", async () => {
    const { session, sendToolResponse } = await connectForTools();
    session.sendToolResponse({ id: "c1", name: "press_digits", args: {} }, "ok");
    expect(sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: "c1", name: "press_digits", response: { output: "ok" } }]
    });
  });

  it("passes turnDetection.silenceDurationMs into the realtime input config", async () => {
    const { config } = await connectForTools({
      turnDetection: { mode: "automatic", silenceDurationMs: 1800 }
    });
    const rt = config.realtimeInputConfig as {
      automaticActivityDetection: { silenceDurationMs: number };
    };
    expect(rt.automaticActivityDetection.silenceDurationMs).toBe(1800);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MULAW_8K, type RealtimeProviderError, type ToolCallRequest } from "@parley/core";
import {
  buildDeepgramSettings,
  createDeepgramRealtimeProvider,
  createDeepgramTurnCompletion,
  DEEPGRAM_AUDIO_ENCODING,
  DEEPGRAM_TURN_QUIET_MS,
  DEEPGRAM_SPEED_MAX,
  DEEPGRAM_SPEED_MIN,
  DEEPGRAM_THINK_MODELS,
  DEEPGRAM_VOICES,
  DEFAULT_DEEPGRAM_LISTEN_MODEL,
  DEFAULT_DEEPGRAM_SPEED,
  DEFAULT_DEEPGRAM_THINK,
  DEFAULT_DEEPGRAM_VOICE,
  type DeepgramSettings
} from "../src/index.js";
import { FakeAgentSocket, connectProvider, startConnect } from "./helpers.js";

const TOOL = {
  name: "end_call" as const,
  description: "End the call.",
  parametersJsonSchema: { type: "object", properties: {} }
};

describe("DeepgramRealtimeProvider declared audio format", () => {
  it("speaks mulaw@8000 both ways and bounds a session at two hours", () => {
    const provider = createDeepgramRealtimeProvider({ apiKey: "k" });
    expect(provider.audio).toEqual({ accepts: [MULAW_8K], emits: MULAW_8K });
    expect(provider.maxSessionSeconds).toBe(7200);
  });

  it("declares the same encoding it puts in Settings, from one constant", () => {
    const provider = createDeepgramRealtimeProvider({ apiKey: "k" });
    expect(provider.audio.emits).toBe(DEEPGRAM_AUDIO_ENCODING);
    expect(provider.audio.accepts).toEqual([DEEPGRAM_AUDIO_ENCODING]);
  });

  /** Its only post-connect text input is `InjectUserMessage`, which the LLM
   * hears as the callee speaking — so the opening rides in the Settings
   * prompt instead. */
  it('takes the opening in its prompt ("prompt" delivery)', () => {
    expect(createDeepgramRealtimeProvider({ apiKey: "k" }).openingDelivery).toBe("prompt");
  });

  /** The billed wire shows `FunctionCallRequest` first and the goodbye in the
   * turn after `FunctionCallResponse` — CallSession's hangup waits on it. */
  it("declares that it goes on speaking after a tool answer", () => {
    expect(createDeepgramRealtimeProvider({ apiKey: "k" }).continuesAfterToolResponse).toBe(true);
  });
});

describe("DeepgramRealtimeProvider handshake", () => {
  it("does not resolve on open; resolves on SettingsApplied", async () => {
    const socket = new FakeAgentSocket();
    let resolved = false;
    const promise = startConnect(socket).then((s) => {
      resolved = true;
      return s;
    });
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Only Settings went out: nothing, audio included, before settings apply.
    expect(socket.sent.map((m) => m.type)).toEqual(["Settings"]);

    socket.emitAgent({ type: "SettingsApplied" });
    await promise;
    expect(resolved).toBe(true);
  });

  it("rejects on an Error before SettingsApplied, reporting it fatal", async () => {
    const socket = new FakeAgentSocket();
    const errors: RealtimeProviderError[] = [];
    const promise = startConnect(socket, { onError: (e) => errors.push(e) });
    socket.open();
    socket.emitAgent({ type: "Error", description: "bad settings", code: "INVALID_SETTINGS" });
    await expect(promise).rejects.toThrow(/deepgram/);
    expect(errors).toEqual([
      expect.objectContaining({ code: "deepgram_agent_error", fatal: true })
    ]);
    expect(socket.closed).toBe(true);
  });

  it("rejects after settingsTimeoutMs (default 10000) with no SettingsApplied", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeAgentSocket();
      const promise = startConnect(socket);
      const settled = vi.fn();
      promise.then(settled, settled);
      socket.open();
      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).rejects.toThrow(/SettingsApplied/);
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a caller-supplied settingsTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeAgentSocket();
      const promise = startConnect(socket, { settingsTimeoutMs: 50 });
      const rejection = expect(promise).rejects.toThrow(/SettingsApplied/);
      socket.open();
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports no further error once the handshake has already failed", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeAgentSocket();
      const onError = vi.fn();
      const promise = startConnect(socket, { onError });
      const rejection = expect(promise).rejects.toThrow(/SettingsApplied/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      socket.emitError(new Error("WebSocket was closed before the connection was established"));
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report a close for a session that never came up", async () => {
    const socket = new FakeAgentSocket();
    const onClose = vi.fn();
    const promise = startConnect(socket, { onClose });
    socket.open();
    socket.emitAgent({ type: "Error", description: "bad", code: "E" });
    await expect(promise).rejects.toThrow();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports the close code and reason structurally, beside the prose", async () => {
    const socket = new FakeAgentSocket();
    const onClose = vi.fn();
    await connectProvider(socket, { onClose });
    socket.emitClose(1011, "credits depleted");
    expect(onClose).toHaveBeenCalledWith("code=1011 reason=credits depleted", {
      code: 1011,
      reason: "credits depleted"
    });
  });

  it("rejects if the socket closes before SettingsApplied", async () => {
    const socket = new FakeAgentSocket();
    const promise = startConnect(socket);
    socket.open();
    socket.close();
    await expect(promise).rejects.toThrow(/deepgram/);
  });
});

describe("Settings", () => {
  it("sends the pinned production values", async () => {
    const socket = new FakeAgentSocket();
    await connectProvider(socket, { systemInstruction: "PERSONA", tools: [TOOL] });
    const settings = socket.sent.find((m) => m.type === "Settings");
    expect(settings).toEqual({
      type: "Settings",
      mip_opt_out: true,
      audio: {
        input: { encoding: "mulaw", sample_rate: 8000 },
        output: { encoding: "mulaw", sample_rate: 8000, container: "none" }
      },
      agent: {
        language: "en",
        listen: { provider: { type: "deepgram", version: "v2", model: "flux-general-en" } },
        think: {
          provider: { type: "open_ai", model: "gpt-4o-mini" },
          prompt: "PERSONA",
          functions: [
            {
              name: "end_call",
              description: "End the call.",
              parameters: { type: "object", properties: {} },
              defer_until_eot: true
            }
          ]
        },
        // Flux voices are served at speak v2; v1 would 400 (verified against /v1/speak).
        // Default voice is Kelsey: Kit was tried but its accent was hard to understand at
        // the pace the live calls needed. Speed 1.25 is the default, chosen by ear on live
        // calls (Deepgram's own ~119 words/min was far too slow; 1.4 tired the ear), so the exact Settings
        // always carry `speed`.
        speak: {
          provider: { type: "deepgram", version: "v2", model: "flux-kelsey-en", speed: 1.25 }
        }
      }
    });
  });

  it("speak speed defaults to 1.25, is overridable, and is range-checked at construction", async () => {
    expect(DEFAULT_DEEPGRAM_SPEED).toBe(1.25);
    const socket = new FakeAgentSocket();
    await connectProvider(socket, { speed: 1.1 });
    const settings = socket.sent.find((m) => m.type === "Settings") as {
      agent: { speak: { provider: { speed: number } } };
    };
    expect(settings.agent.speak.provider.speed).toBe(1.1);
    for (const speed of [0.6, 1.6, NaN, Infinity]) {
      expect(() => createDeepgramRealtimeProvider({ apiKey: "k", speed })).toThrow(/speed/);
    }
    for (const speed of [DEEPGRAM_SPEED_MIN, DEEPGRAM_SPEED_MAX]) {
      expect(() => createDeepgramRealtimeProvider({ apiKey: "k", speed })).not.toThrow();
    }
  });

  it("exports the defaults it uses", () => {
    // What Deepgram's own telephony reference agents use, in the Standard tier.
    expect(DEFAULT_DEEPGRAM_THINK).toEqual({ provider: "open_ai", model: "gpt-4o-mini" });
    expect(DEFAULT_DEEPGRAM_LISTEN_MODEL).toBe("flux-general-en");
    expect(DEFAULT_DEEPGRAM_VOICE).toBe("flux-kelsey-en");
  });

  it("carries params.keyterms on the listen provider when present", async () => {
    const socket = new FakeAgentSocket();
    await connectProvider(socket, { keyterms: ["Nguyen", "Parley"] });
    const settings = socket.sent.find((m) => m.type === "Settings") as {
      agent: { listen: { provider: Record<string, unknown> } };
    };
    expect(settings.agent.listen.provider.keyterms).toEqual(["Nguyen", "Parley"]);
  });

  it("omits keyterms entirely when params carry none (or an empty list)", async () => {
    for (const keyterms of [undefined, []]) {
      const socket = new FakeAgentSocket();
      await connectProvider(socket, keyterms ? { keyterms } : {});
      const settings = socket.sent.find((m) => m.type === "Settings") as {
        agent: { listen: { provider: Record<string, unknown> } };
      };
      expect("keyterms" in settings.agent.listen.provider).toBe(false);
    }
  });

  it("omits functions when no tools are declared", async () => {
    const socket = new FakeAgentSocket();
    await connectProvider(socket);
    const settings = socket.sent.find((m) => m.type === "Settings") as {
      agent: { think: Record<string, unknown> };
    };
    expect("functions" in settings.agent.think).toBe(false);
  });

  it("buildDeepgramSettings is pure and honours think/listen/voice overrides", () => {
    const params = {
      model: "ignored",
      systemInstruction: "P",
      responseModality: "audio" as const,
      tools: [TOOL],
      callbacks: {
        onAudio: () => {},
        onInterrupted: () => {},
        onTranscript: () => {},
        onError: () => {},
        onClose: () => {}
      }
    };
    const opts = {
      think: { provider: "anthropic", model: "claude-haiku-4-5" },
      listenModel: "flux-other",
      voice: "flux-other-voice",
      speed: 1.2
    };
    const a = buildDeepgramSettings(params, opts);
    expect(buildDeepgramSettings(params, opts)).toEqual(a);
    expect(a.agent.think.provider).toEqual({ type: "anthropic", model: "claude-haiku-4-5" });
    expect(a.agent.listen.provider.model).toBe("flux-other");
    expect(a.agent.speak.provider.model).toBe("flux-other-voice");
    expect(a.agent.speak.provider.speed).toBe(1.2);
    expect(a.agent.think.functions?.every((f) => f.defer_until_eot === true)).toBe(true);
  });

  it("a per-connect voice overrides the provider voice", () => {
    const settings = buildDeepgramSettings(
      {
        model: "m",
        systemInstruction: "P",
        responseModality: "audio",
        voice: "per-call-voice",
        callbacks: {
          onAudio: () => {},
          onInterrupted: () => {},
          onTranscript: () => {},
          onError: () => {},
          onClose: () => {}
        }
      },
      { think: DEFAULT_DEEPGRAM_THINK, listenModel: "l", voice: "provider-voice", speed: 1.4 }
    );
    expect(settings.agent.speak.provider.model).toBe("per-call-voice");
  });

  describe("speak version follows the voice family", () => {
    const build = (voice: string) =>
      buildDeepgramSettings(
        {
          model: "m",
          systemInstruction: "P",
          responseModality: "audio",
          voice,
          callbacks: {
            onAudio: () => {},
            onInterrupted: () => {},
            onTranscript: () => {},
            onError: () => {},
            onClose: () => {}
          }
        },
        { think: DEFAULT_DEEPGRAM_THINK, listenModel: "l", voice: "unused", speed: 1.4 }
      ).agent.speak.provider;

    it("declares v2 for a per-connect Flux voice", () => {
      expect(build("flux-kit-en").version).toBe("v2");
    });
    it("declares v1 for an Aura voice", () => {
      expect(build("aura-2-cordelia-en").version).toBe("v1");
    });
    it("declares v1 for an Aura voice set via the provider option (PARLEY_DEEPGRAM_VOICE)", () => {
      const settings = buildDeepgramSettings(
        {
          model: "m",
          systemInstruction: "P",
          responseModality: "audio",
          callbacks: {
            onAudio: () => {},
            onInterrupted: () => {},
            onTranscript: () => {},
            onError: () => {},
            onClose: () => {}
          }
        },
        {
          think: DEFAULT_DEEPGRAM_THINK,
          listenModel: "l",
          voice: "aura-2-cordelia-en",
          speed: 1.4
        }
      );
      expect(settings.agent.speak.provider.version).toBe("v1");
    });
    it("omits the version for an unrecognised voice", () => {
      expect("version" in build("per-call-voice")).toBe(false);
    });
  });
});

describe("DeepgramRealtimeProvider invariants", () => {
  it("sends the systemInstruction EXACTLY ONCE, in the settings message", async () => {
    const socket = new FakeAgentSocket();
    await connectProvider(socket, { systemInstruction: "PERSONA AND RULES" });
    const settings = socket.sent.filter((m) => m.type === "Settings");
    expect(settings).toHaveLength(1);
    expect(JSON.stringify(settings[0])).toContain("PERSONA AND RULES");
  });

  it("exposes NO method that could re-instruct the model mid-session", async () => {
    const socket = new FakeAgentSocket();
    const session = await connectProvider(socket);
    expect(Object.keys(session).sort()).toEqual([
      "close",
      "notifyActivityEnd",
      "sendAudio",
      "sendOpeningTrigger",
      "sendToolResponse"
    ]);
  });

  it("never sends the systemInstruction again after any later call", async () => {
    const socket = new FakeAgentSocket();
    const session = await connectProvider(socket, { systemInstruction: "PERSONA AND RULES" });
    session.sendOpeningTrigger("Begin the call naturally now.");
    session.sendAudio({ encoding: { codec: "mulaw", sampleRate: 8000 }, data: Buffer.alloc(160) });
    const occurrences = socket.sent.filter((m) => JSON.stringify(m).includes("PERSONA AND RULES"));
    expect(occurrences).toHaveLength(1);
  });

  it("maps a tool response to the closed ToolResult union and nothing else", async () => {
    const socket = new FakeAgentSocket();
    const session = await connectProvider(socket);
    session.sendToolResponse(
      { id: "1", name: "end_call", args: {} },
      "refused: tool not available"
    );
    const reply = socket.sent.find((m) => m.type === "FunctionCallResponse");
    expect(JSON.stringify(reply)).toContain("refused: tool not available");
    // The callee's own words must have no route into a tool result.
    expect(JSON.stringify(reply)).not.toMatch(/transcript|utterance/i);
  });

  it("maps the agent's interruption event onto onInterrupted", async () => {
    const socket = new FakeAgentSocket();
    const seen: string[] = [];
    await connectProvider(socket, { onInterrupted: () => seen.push("interrupted") });
    socket.emitAgent({ type: "UserStartedSpeaking" });
    expect(seen).toEqual(["interrupted"]);
  });

  it("emits mulaw@8000 outbound so no resampling sits on the call path", async () => {
    const socket = new FakeAgentSocket();
    const frames: { encoding: { codec: string; sampleRate: number } }[] = [];
    await connectProvider(socket, { onAudio: (f) => frames.push(f) });
    socket.emitBinary(Buffer.alloc(160));
    expect(frames[0]?.encoding).toEqual({ codec: "mulaw", sampleRate: 8000 });
  });

  it("tags the non-assistant ConversationText role 'participant' when speakerRole says so", async () => {
    const socket = new FakeAgentSocket();
    const seen: unknown[] = [];
    await connectProvider(socket, {
      speakerRole: "participant",
      onTranscript: (e) => seen.push(e)
    });
    socket.emitAgent({ type: "ConversationText", role: "user", content: "far end speaking" });
    expect(seen).toEqual([{ speaker: "participant", text: "far end speaking", isFinal: true }]);
  });

  it("defaults the non-assistant ConversationText role to 'caller' when speakerRole is absent", async () => {
    const socket = new FakeAgentSocket();
    const seen: unknown[] = [];
    await connectProvider(socket, { onTranscript: (e) => seen.push(e) });
    socket.emitAgent({ type: "ConversationText", role: "user", content: "far end speaking" });
    expect(seen).toEqual([{ speaker: "caller", text: "far end speaking", isFinal: true }]);
  });
});

describe("turns", () => {
  // A turn now ends DEEPGRAM_TURN_QUIET_MS after its AgentAudioDone, not on
  // it (see "a turn is complete only when its audio stops" below), so this
  // advances fake time past the window before asserting the one completion.
  it("AgentAudioDone → onTurnComplete, once, after the quiet window", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeAgentSocket();
      const onTurnComplete = vi.fn();
      await connectProvider(socket, { onTurnComplete });
      socket.emitAgent({ type: "AgentAudioDone" });
      await vi.advanceTimersByTimeAsync(DEEPGRAM_TURN_QUIET_MS);
      expect(onTurnComplete).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10 * DEEPGRAM_TURN_QUIET_MS);
      expect(onTurnComplete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("UserStartedSpeaking → onInterrupted and not onTurnComplete", async () => {
    const socket = new FakeAgentSocket();
    const onInterrupted = vi.fn();
    const onTurnComplete = vi.fn();
    await connectProvider(socket, { onInterrupted, onTurnComplete });
    socket.emitAgent({ type: "UserStartedSpeaking" });
    expect(onInterrupted).toHaveBeenCalledOnce();
    expect(onTurnComplete).not.toHaveBeenCalled();
  });
});

/** Billed wire log (t20 dghk-fix2, socket 2): `end_call`, an
 * `AgentAudioDone`, then ~10 KB (~1.3 s) more agent audio, then a second
 * `AgentAudioDone`. CallSession's farewell waits for the first turn
 * completion and then drains only audio already queued, so ending the turn on
 * the first `AgentAudioDone` hung up over the rest of the goodbye. A turn is
 * complete only once an `AgentAudioDone` has arrived AND the audio has been
 * quiet for the window since. */
describe("a turn is complete only when its audio stops", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const audio = (): Buffer => Buffer.alloc(160, 0xff);

  it("is 300 ms", () => {
    expect(DEEPGRAM_TURN_QUIET_MS).toBe(300);
  });

  it("AgentAudioDone then quiet: fires once, and not before the window closes", async () => {
    const socket = new FakeAgentSocket();
    const onTurnComplete = vi.fn();
    await connectProvider(socket, { onTurnComplete });
    socket.emitBinary(audio());
    socket.emitAgent({ type: "AgentAudioDone" });
    await vi.advanceTimersByTimeAsync(DEEPGRAM_TURN_QUIET_MS - 1);
    expect(onTurnComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTurnComplete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(onTurnComplete).toHaveBeenCalledOnce();
  });

  it("done → audio → done → quiet: fires once, a full window after the last AgentAudioDone", async () => {
    const socket = new FakeAgentSocket();
    const onTurnComplete = vi.fn();
    await connectProvider(socket, { onTurnComplete });
    socket.emitAgent({ type: "AgentAudioDone" });
    await vi.advanceTimersByTimeAsync(100);
    // The goodbye goes on: audio inside the window cancels the completion.
    socket.emitBinary(audio());
    await vi.advanceTimersByTimeAsync(DEEPGRAM_TURN_QUIET_MS);
    expect(onTurnComplete).not.toHaveBeenCalled();
    socket.emitBinary(audio());
    socket.emitAgent({ type: "AgentAudioDone" });
    await vi.advanceTimersByTimeAsync(DEEPGRAM_TURN_QUIET_MS - 1);
    expect(onTurnComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTurnComplete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(onTurnComplete).toHaveBeenCalledOnce();
  });

  it("reports how soon audio resumed after an AgentAudioDone, once per such event", async () => {
    // Content-free timing: it says how long the early done preceded the rest
    // of the reply, which is what the quiet window has to be longer than.
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    await connectProvider(socket, { onDiagnostic });
    socket.emitBinary(audio());
    expect(onDiagnostic).not.toHaveBeenCalled();
    socket.emitAgent({ type: "AgentAudioDone" });
    await vi.advanceTimersByTimeAsync(120);
    socket.emitBinary(audio());
    socket.emitBinary(audio());
    const resumed = onDiagnostic.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.startsWith("deepgram audio resumed"));
    expect(resumed).toEqual(["deepgram audio resumed 120ms after AgentAudioDone"]);
    // A second done, resumed again, is a second event.
    socket.emitAgent({ type: "AgentAudioDone" });
    await vi.advanceTimersByTimeAsync(40);
    socket.emitBinary(audio());
    expect(
      onDiagnostic.mock.calls.filter((c) => String(c[0]).startsWith("deepgram audio resumed"))
    ).toHaveLength(2);
    // Audio after the turn completed is a new turn, not a resume.
    socket.emitAgent({ type: "AgentAudioDone" });
    await vi.advanceTimersByTimeAsync(DEEPGRAM_TURN_QUIET_MS);
    socket.emitBinary(audio());
    expect(
      onDiagnostic.mock.calls.filter((c) => String(c[0]).startsWith("deepgram audio resumed"))
    ).toHaveLength(2);
  });

  it("close during the window fires nothing", async () => {
    const socket = new FakeAgentSocket();
    const onTurnComplete = vi.fn();
    const session = await connectProvider(socket, { onTurnComplete });
    socket.emitAgent({ type: "AgentAudioDone" });
    await session.close();
    await vi.advanceTimersByTimeAsync(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it("a frame arriving after close is not reported as audio resuming after a stale done", async () => {
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    const session = await connectProvider(socket, { onDiagnostic });
    socket.emitAgent({ type: "AgentAudioDone" });
    await session.close();
    await vi.advanceTimersByTimeAsync(50);
    socket.emitBinary(audio());
    expect(
      onDiagnostic.mock.calls.filter((c) => String(c[0]).startsWith("deepgram audio resumed"))
    ).toHaveLength(0);
  });

  it("a socket closed by the far side during the window fires nothing", async () => {
    const socket = new FakeAgentSocket();
    const onTurnComplete = vi.fn();
    await connectProvider(socket, { onTurnComplete });
    socket.emitAgent({ type: "AgentAudioDone" });
    socket.close();
    await vi.advanceTimersByTimeAsync(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it("audio with no AgentAudioDone never completes a turn", async () => {
    const socket = new FakeAgentSocket();
    const onTurnComplete = vi.fn();
    await connectProvider(socket, { onTurnComplete });
    socket.emitBinary(audio());
    await vi.advanceTimersByTimeAsync(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(onTurnComplete).not.toHaveBeenCalled();
  });
});

describe("createDeepgramTurnCompletion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes once, a quiet window after the last done, and never after cancel", () => {
    const onComplete = vi.fn();
    const turn = createDeepgramTurnCompletion(onComplete);
    turn.audioDone();
    turn.audioDone();
    vi.advanceTimersByTime(DEEPGRAM_TURN_QUIET_MS);
    expect(onComplete).toHaveBeenCalledOnce();

    turn.audioDone();
    turn.audio();
    vi.advanceTimersByTime(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(onComplete).toHaveBeenCalledOnce();

    turn.audioDone();
    turn.cancel();
    vi.advanceTimersByTime(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe("vendor errors and warnings", () => {
  it("an Error after ready → onError deepgram_agent_error, non-fatal; session stays open", async () => {
    const socket = new FakeAgentSocket();
    const errors: RealtimeProviderError[] = [];
    const session = await connectProvider(socket, { onError: (e) => errors.push(e) });
    expect(() =>
      socket.emitAgent({ type: "Error", description: "think provider hiccup", code: "X" })
    ).not.toThrow();
    expect(errors).toEqual([
      expect.objectContaining({ code: "deepgram_agent_error", fatal: false })
    ]);
    expect(socket.closed).toBe(false);
    expect(() => session.sendAudio({ encoding: MULAW_8K, data: Buffer.alloc(160) })).not.toThrow();
  });

  it("Warning → onDiagnostic; no error, no throw, session stays open", async () => {
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    const onError = vi.fn();
    await connectProvider(socket, { onDiagnostic, onError });
    expect(() =>
      socket.emitAgent({ type: "Warning", description: "slow think", code: "W1" })
    ).not.toThrow();
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic.mock.calls[0]?.[0]).toMatch(/^deepgram Warning/);
    expect(onError).not.toHaveBeenCalled();
    expect(socket.closed).toBe(false);
  });

  it("InjectionRefused → onDiagnostic; no error, no throw, session stays open", async () => {
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    const onError = vi.fn();
    await connectProvider(socket, { onDiagnostic, onError });
    expect(() =>
      socket.emitAgent({ type: "InjectionRefused", message: "agent is speaking" })
    ).not.toThrow();
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic.mock.calls[0]?.[0]).toMatch(/^deepgram InjectionRefused/);
    expect(onError).not.toHaveBeenCalled();
    expect(socket.closed).toBe(false);
  });

  it("tolerates Warning and InjectionRefused with no diagnostics channel wired", async () => {
    const socket = new FakeAgentSocket();
    await connectProvider(socket);
    expect(() => socket.emitAgent({ type: "Warning", description: "w" })).not.toThrow();
    expect(() => socket.emitAgent({ type: "InjectionRefused", message: "m" })).not.toThrow();
  });
});

describe("function calls", () => {
  it("client_side:false is ignored — no onToolCall, no response sent", async () => {
    const socket = new FakeAgentSocket();
    const onToolCall = vi.fn();
    await connectProvider(socket, { onToolCall });
    const before = socket.sent.length;
    socket.emitAgent({
      type: "FunctionCallRequest",
      functions: [{ id: "s1", name: "server_fn", arguments: "{}", client_side: false }]
    });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(socket.sent.length).toBe(before);
  });

  it("client_side:true → onToolCall once with parsed arguments", async () => {
    const socket = new FakeAgentSocket();
    const calls: ToolCallRequest[] = [];
    await connectProvider(socket, { onToolCall: (c) => calls.push(c) });
    socket.emitAgent({
      type: "FunctionCallRequest",
      functions: [{ id: "c1", name: "end_call", arguments: '{"a":1}', client_side: true }]
    });
    expect(calls).toEqual([{ id: "c1", name: "end_call", args: { a: 1 } }]);
  });

  it("FunctionCallCancelled{id} for an unanswered call → diagnostic, and its later response is dropped", async () => {
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    const calls: ToolCallRequest[] = [];
    const session = await connectProvider(socket, {
      onDiagnostic,
      onToolCall: (c) => calls.push(c)
    });
    socket.emitAgent({
      type: "FunctionCallRequest",
      functions: [{ id: "c1", name: "end_call", arguments: "{}", client_side: true }]
    });
    socket.emitAgent({ type: "FunctionCallCancelled", id: "c1" });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringMatching(/FunctionCallCancelled.*c1/));

    session.sendToolResponse(calls[0]!, "ok");
    expect(socket.sent.filter((m) => m.type === "FunctionCallResponse")).toHaveLength(0);
  });

  it("FunctionCallCancelled carrying functions[].id is honoured too", async () => {
    const socket = new FakeAgentSocket();
    const calls: ToolCallRequest[] = [];
    const session = await connectProvider(socket, { onToolCall: (c) => calls.push(c) });
    socket.emitAgent({
      type: "FunctionCallRequest",
      functions: [{ id: "c2", name: "end_call", arguments: "{}", client_side: true }]
    });
    socket.emitAgent({ type: "FunctionCallCancelled", functions: [{ id: "c2" }] });
    session.sendToolResponse(calls[0]!, "ok");
    expect(socket.sent.filter((m) => m.type === "FunctionCallResponse")).toHaveLength(0);
  });

  it("a response for a call that was not cancelled is still sent", async () => {
    const socket = new FakeAgentSocket();
    const calls: ToolCallRequest[] = [];
    const session = await connectProvider(socket, { onToolCall: (c) => calls.push(c) });
    socket.emitAgent({
      type: "FunctionCallRequest",
      functions: [{ id: "c3", name: "end_call", arguments: "{}", client_side: true }]
    });
    socket.emitAgent({ type: "FunctionCallCancelled", id: "other" });
    session.sendToolResponse(calls[0]!, "ok");
    expect(socket.sent.filter((m) => m.type === "FunctionCallResponse")).toEqual([
      { type: "FunctionCallResponse", id: "c3", name: "end_call", content: "ok" }
    ]);
  });
});

describe("latency telemetry", () => {
  it.each([
    ["ttt_token_latency", 0.627949202, "deepgram latency ttt_token_latency=628ms"],
    ["ttt_text_latency", 0.5, "deepgram latency ttt_text_latency=500ms"],
    ["tts_latency", 0.21, "deepgram latency tts_latency=210ms"],
    ["total_latency", 1.13, "deepgram latency total_latency=1130ms"],
    ["ttt_tool_latency", 0.0004, "deepgram latency ttt_tool_latency=0ms"]
  ])("LatencyReport %s → exactly one diagnostic in ms", async (field, seconds, line) => {
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    await connectProvider(socket, { onDiagnostic });
    onDiagnostic.mockClear();
    socket.emitAgent({ type: "LatencyReport", [field]: seconds });
    expect(onDiagnostic.mock.calls.map((c) => c[0])).toEqual([line]);
  });

  it("LatencyReport with a non-numeric value or unknown field → no diagnostic", async () => {
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    await connectProvider(socket, { onDiagnostic });
    onDiagnostic.mockClear();
    socket.emitAgent({ type: "LatencyReport", total_latency: "fast" });
    socket.emitAgent({ type: "LatencyReport", some_other_field: 1.2 });
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it("AgentStartedSpeaking latencies → one content-free diagnostic", async () => {
    const socket = new FakeAgentSocket();
    const onDiagnostic = vi.fn();
    await connectProvider(socket, { onDiagnostic });
    socket.emitAgent({
      type: "AgentStartedSpeaking",
      total_latency: 1.13,
      tts_latency: 0.21,
      ttt_latency: 0.92
    });
    expect(onDiagnostic).toHaveBeenCalledWith("deepgram latency total=1.13 tts=0.21 ttt=0.92");
  });
});

describe("KeepAlive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const keepAlives = (socket: FakeAgentSocket) => socket.sent.filter((m) => m.type === "KeepAlive");

  it("sends one KeepAlive after 8000 ms with no audio", async () => {
    const socket = new FakeAgentSocket();
    await connectProvider(socket);
    await vi.advanceTimersByTimeAsync(7999);
    expect(keepAlives(socket)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(keepAlives(socket)).toEqual([{ type: "KeepAlive" }]);
  });

  it("audio resets the timer", async () => {
    const socket = new FakeAgentSocket();
    const session = await connectProvider(socket);
    await vi.advanceTimersByTimeAsync(5000);
    session.sendAudio({ encoding: MULAW_8K, data: Buffer.alloc(160) });
    await vi.advanceTimersByTimeAsync(7999);
    expect(keepAlives(socket)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(keepAlives(socket)).toHaveLength(1);
  });

  it("close() clears it", async () => {
    const socket = new FakeAgentSocket();
    const session = await connectProvider(socket);
    await session.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(keepAlives(socket)).toHaveLength(0);
  });
});

/** Per-call settings (`RealtimeConnectParams.settings`) override the provider's
 * options for ONE session. The options themselves are never mutated: the next
 * session on the same provider is back on the constructor's values. */
describe("per-call settings", () => {
  function twoSessionProvider(sockets: FakeAgentSocket[]) {
    let i = 0;
    return createDeepgramRealtimeProvider({
      apiKey: "test-key",
      wsFactory: () => sockets[i++] as never
    });
  }
  const callbacks = {
    onAudio: () => {},
    onInterrupted: () => {},
    onTranscript: () => {},
    onError: () => {},
    onClose: () => {}
  };
  async function open(
    provider: ReturnType<typeof createDeepgramRealtimeProvider>,
    socket: FakeAgentSocket,
    extra: Partial<Parameters<typeof provider.connect>[0]> = {}
  ): Promise<DeepgramSettings> {
    const p = provider.connect({
      model: "ignored",
      systemInstruction: "P",
      responseModality: "audio",
      callbacks,
      ...extra
    });
    socket.open();
    socket.emitAgent({ type: "SettingsApplied" });
    await p;
    return socket.sent.find((m) => m.type === "Settings") as unknown as DeepgramSettings;
  }

  it("sends the per-call think model and speed, then reverts to the defaults", async () => {
    const sockets = [new FakeAgentSocket(), new FakeAgentSocket()];
    const provider = twoSessionProvider(sockets);
    const first = await open(provider, sockets[0]!, {
      settings: { think: { provider: "anthropic", model: "claude-haiku-4-5" }, speed: 1.1 }
    });
    expect(first.agent.think.provider).toEqual({ type: "anthropic", model: "claude-haiku-4-5" });
    expect(first.agent.speak.provider.speed).toBe(1.1);

    const second = await open(provider, sockets[1]!);
    expect(second.agent.think.provider).toEqual({
      type: DEFAULT_DEEPGRAM_THINK.provider,
      model: DEFAULT_DEEPGRAM_THINK.model
    });
    expect(second.agent.speak.provider.speed).toBe(DEFAULT_DEEPGRAM_SPEED);
  });

  it("sends expressivity in speak.provider only when set", async () => {
    const sockets = [new FakeAgentSocket(), new FakeAgentSocket()];
    const provider = twoSessionProvider(sockets);
    const set = await open(provider, sockets[0]!, { settings: { expressivity: -1 } });
    expect(set.agent.speak.provider.expressivity).toBe(-1);
    const unset = await open(provider, sockets[1]!);
    expect("expressivity" in unset.agent.speak.provider).toBe(false);
  });

  it("sends expressivity 0 when set to 0 (a value, not an absence)", async () => {
    const socket = new FakeAgentSocket();
    const settings = await open(twoSessionProvider([socket]), socket, {
      settings: { expressivity: 0 }
    });
    expect(settings.agent.speak.provider.expressivity).toBe(0);
  });

  it("rejects a per-call speed outside the range Deepgram accepts, before opening a socket", async () => {
    const opened = vi.fn();
    const provider = createDeepgramRealtimeProvider({ apiKey: "test-key", wsFactory: opened });
    await expect(
      provider.connect({
        model: "m",
        systemInstruction: "P",
        responseModality: "audio",
        callbacks,
        settings: { speed: 2 }
      })
    ).rejects.toThrow(/speed/);
    expect(opened).not.toHaveBeenCalled();
  });

  it("exports the think models it supports, each with its managed think provider", () => {
    expect(DEEPGRAM_THINK_MODELS).toEqual({
      "gpt-4o-mini": "open_ai",
      "gpt-4.1-mini": "open_ai",
      "gpt-5.4-mini": "open_ai",
      "claude-haiku-4-5": "anthropic",
      "claude-sonnet-4-6": "anthropic",
      "gemini-3.5-flash": "google"
    });
    expect(DEEPGRAM_THINK_MODELS[DEFAULT_DEEPGRAM_THINK.model]).toBe(
      DEFAULT_DEEPGRAM_THINK.provider
    );
  });

  it("exports its voices, the default among them", () => {
    expect(DEEPGRAM_VOICES).toContain(DEFAULT_DEEPGRAM_VOICE);
    expect(DEEPGRAM_VOICES).toContain("flux-kit-en");
    expect(DEEPGRAM_VOICES).toContain("aura-2-cordelia-en");
    expect(new Set(DEEPGRAM_VOICES).size).toBe(DEEPGRAM_VOICES.length);
  });
});

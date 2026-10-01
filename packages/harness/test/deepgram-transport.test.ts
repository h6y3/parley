import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDeclaration } from "@parley/core";
import {
  buildDeepgramSettings,
  createDeepgramRealtimeProvider,
  DEEPGRAM_AGENT_URL,
  DEEPGRAM_TURN_QUIET_MS,
  DEFAULT_DEEPGRAM_LISTEN_MODEL,
  DEFAULT_DEEPGRAM_SPEED,
  DEFAULT_DEEPGRAM_VOICE
} from "@parley/realtime-deepgram";
import { deepgramTransport } from "../src/transports/deepgram-transport.js";
import type { ScenarioTransport } from "../src/scenario-transport.js";

type Handler = (...a: unknown[]) => void;

/** The Voice Agent socket, faked at the `wsFactory` seam. */
class FakeAgentSocket {
  readonly sent: Record<string, unknown>[] = [];
  closedByClient = false;
  private readonly handlers: Record<string, Handler[]> = {};
  on(event: string, fn: Handler): void {
    (this.handlers[event] ??= []).push(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
  send(data: Buffer | string): void {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : { type: "binary" });
  }
  close(): void {
    this.closedByClient = true;
    this.emit("close", 1000, Buffer.from("done"));
  }
  agentSays(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  /** A binary frame of the agent's speech. */
  agentAudio(): void {
    this.emit("message", Buffer.alloc(160, 0xff), true);
  }
}

/** Let an `AgentAudioDone` become a turn end: the transport, like
 * production, waits DEEPGRAM_TURN_QUIET_MS of quiet after it. */
const quiet = (): void => void vi.advanceTimersByTime(DEEPGRAM_TURN_QUIET_MS);

const THINK = { provider: "open_ai", model: "gpt-5.4-mini" };
const TOOL: ToolDeclaration = {
  name: "press_digits",
  description: "press",
  parametersJsonSchema: { type: "object", properties: { digits: { type: "string" } } }
};

function harness(opts: { settingsTimeoutMs?: number } = {}) {
  const sockets: { url: string; headers: Record<string, string>; socket: FakeAgentSocket }[] = [];
  const transport = deepgramTransport({
    apiKey: "test-key",
    think: THINK,
    ...opts,
    wsFactory: (url, headers) => {
      const socket = new FakeAgentSocket();
      sockets.push({ url, headers, socket });
      return socket as never;
    }
  });
  const events: string[] = [];
  const on: Parameters<ScenarioTransport["connect"]>[0]["on"] = {
    modelText: (t) => events.push(`text:${t}`),
    modelAudio: () => events.push("audio"),
    turnComplete: () => events.push("complete"),
    toolCall: (c) => events.push(`tool:${c.id}:${c.name}:${JSON.stringify(c.args)}`),
    closed: (r) => events.push(`closed:${r}`),
    diagnostic: (m) => events.push(`diag:${m}`)
  };
  const socket = (): FakeAgentSocket => sockets[0].socket;
  /** Connect and complete the handshake. */
  const connected = async (): Promise<FakeAgentSocket> => {
    const pending = transport.connect({ systemInstruction: "SYS", tools: [TOOL], on });
    socket().emit("open");
    socket().agentSays({ type: "SettingsApplied" });
    await pending;
    return socket();
  };
  return { transport, sockets, events, on, socket, connected };
}

describe("the Deepgram scenario transport's opening delivery", () => {
  it("declares what the production provider declares, so the runner plans the same opening", () => {
    const production = createDeepgramRealtimeProvider({ apiKey: "k" }).openingDelivery;
    expect(production).toBe("prompt");
    expect(harness().transport.openingDelivery).toBe(production);
  });
});

describe("the Deepgram scenario transport's handshake", () => {
  it("opens the production URL with the key in a header, never the URL", async () => {
    const h = harness();
    await h.connected();
    expect(h.sockets[0].url).toBe(DEEPGRAM_AGENT_URL);
    expect(h.sockets[0].headers).toEqual({ Authorization: "Token test-key" });
  });

  it("sends production's Settings, built by the same function production uses", async () => {
    // Text-only still sends the audio settings: Deepgram requires them, and a
    // hand-rolled harness Settings is how harness and production drift.
    const h = harness();
    await h.connected();
    const expected = buildDeepgramSettings(
      {
        model: THINK.model,
        systemInstruction: "SYS",
        responseModality: "audio",
        tools: [TOOL],
        callbacks: {} as never
      },
      {
        think: THINK,
        listenModel: DEFAULT_DEEPGRAM_LISTEN_MODEL,
        voice: DEFAULT_DEEPGRAM_VOICE,
        speed: DEFAULT_DEEPGRAM_SPEED
      }
    );
    expect(h.socket().sent[0]).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("resolves only once SettingsApplied arrives", async () => {
    const h = harness();
    let resolved = false;
    const pending = h.transport
      .connect({ systemInstruction: "SYS", tools: [], on: h.on })
      .then(() => (resolved = true));
    h.socket().emit("open");
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    h.socket().agentSays({ type: "SettingsApplied" });
    await pending;
    expect(resolved).toBe(true);
  });

  it("rejects on an Error before SettingsApplied", async () => {
    const h = harness();
    const pending = h.transport.connect({ systemInstruction: "SYS", tools: [], on: h.on });
    h.socket().emit("open");
    h.socket().agentSays({ type: "Error", code: "INVALID_SETTINGS", description: "bad" });
    await expect(pending).rejects.toThrow(/INVALID_SETTINGS/);
    expect(h.events).toEqual([]);
  });

  it("rejects when SettingsApplied never comes", async () => {
    const h = harness({ settingsTimeoutMs: 20 });
    const pending = h.transport.connect({ systemInstruction: "SYS", tools: [], on: h.on });
    h.socket().emit("open");
    await expect(pending).rejects.toThrow(/SettingsApplied/);
  });

  it("rejects when the socket closes before SettingsApplied", async () => {
    const h = harness();
    const pending = h.transport.connect({ systemInstruction: "SYS", tools: [], on: h.on });
    h.socket().emit("close", 1006, Buffer.from(""));
    await expect(pending).rejects.toThrow(/closed before SettingsApplied/);
  });
});

describe("the Deepgram scenario transport's wire", () => {
  // A turn now ends DEEPGRAM_TURN_QUIET_MS after its AgentAudioDone (see
  // "counts the turn complete only once its audio has stopped"), so every
  // test here runs on fake time and the ones that expect a turn end advance
  // past the window with `quiet()`.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts a callee line to the model as InjectUserMessage", async () => {
    const h = harness();
    const socket = await h.connected();
    h.transport.sendCalleeText("For service, press one.");
    expect(socket.sent.at(-1)).toEqual({
      type: "InjectUserMessage",
      content: "For service, press one."
    });
  });

  it("reads the model's words from ConversationText, assistant role only", async () => {
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({ type: "ConversationText", role: "user", content: "For service" });
    socket.agentSays({ type: "ConversationText", role: "assistant", content: "Pressing one." });
    socket.agentSays({ type: "ConversationText", role: "assistant", content: "" });
    expect(h.events).toEqual(["text:Pressing one."]);
  });

  it("ends the model's turn on AgentAudioDone, once its audio has stayed quiet", async () => {
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({ type: "AgentAudioDone" });
    quiet();
    expect(h.events).toEqual(["complete"]);
  });

  it("does not end a turn on the AgentAudioDone of a turn a callee line barged in on", async () => {
    // Billed wire order: a line injected while agent audio still
    // streams interrupts it, and the interrupted turn's AgentAudioDone lands
    // between UserStartedSpeaking and the line's own echo. Read as the reply,
    // it put every later line one turn ahead of the model for the rest of
    // the run, each one barging in again.
    const h = harness();
    const socket = await h.connected();
    h.transport.sendCalleeText("How can I help you today?");
    socket.agentSays({ type: "UserStartedSpeaking" });
    socket.agentSays({ type: "AgentAudioDone" });
    socket.agentSays({
      type: "ConversationText",
      role: "user",
      content: "How can I help you today?"
    });
    socket.agentSays({ type: "EndOfTurn", trigger: "manual" });
    quiet();
    expect(h.events.filter((e) => e === "complete")).toEqual([]);
    // The reply to the line ends its own turn as usual.
    socket.agentSays({ type: "ConversationText", role: "assistant", content: "Hi Mark." });
    socket.agentSays({ type: "AgentAudioDone" });
    quiet();
    expect(h.events.filter((e) => !e.startsWith("diag:"))).toEqual(["text:Hi Mark.", "complete"]);
  });

  it("still ends a silent reply to a line on its zero-audio AgentAudioDone", async () => {
    const h = harness();
    const socket = await h.connected();
    h.transport.sendCalleeText("One moment while I look that up.");
    socket.agentSays({ type: "UserStartedSpeaking" });
    socket.agentSays({ type: "ConversationText", role: "user", content: "One moment." });
    socket.agentSays({ type: "EndOfTurn", trigger: "manual" });
    socket.agentSays({ type: "AgentAudioDone" });
    quiet();
    expect(h.events).toEqual(["complete"]);
  });

  it("counts the turn complete only once its audio has stopped (the same rule as production)", async () => {
    // Billed wire order (t20 dghk-fix2, socket 2): AgentAudioDone, ~1.3 s
    // more of the same reply's audio, then a second AgentAudioDone. The turn
    // ends a quiet window after the LAST one — once.
    const h = harness();
    const socket = await h.connected();
    const ends = (): string[] => h.events.filter((e) => e !== "audio");
    socket.agentAudio();
    socket.agentSays({ type: "AgentAudioDone" });
    vi.advanceTimersByTime(DEEPGRAM_TURN_QUIET_MS - 1);
    expect(ends()).toEqual([]);
    socket.agentAudio();
    vi.advanceTimersByTime(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(ends()).toEqual([]);
    socket.agentAudio();
    socket.agentSays({ type: "AgentAudioDone" });
    vi.advanceTimersByTime(DEEPGRAM_TURN_QUIET_MS - 1);
    expect(ends()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ends()).toEqual(["complete"]);
    vi.advanceTimersByTime(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(ends()).toEqual(["complete"]);
  });

  it("reports no turn end once the run has closed the session", async () => {
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({ type: "AgentAudioDone" });
    await h.transport.close();
    vi.advanceTimersByTime(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(h.events).toEqual([]);
  });

  it("reports no turn end after the session closes underneath the run", async () => {
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({ type: "AgentAudioDone" });
    socket.emit("close", 1011, Buffer.from("internal"));
    vi.advanceTimersByTime(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(h.events.filter((e) => e === "complete")).toEqual([]);
  });

  it("does not pass on a turn end still settling when a callee line goes out", async () => {
    // The line lands on that turn — the same case as an AgentAudioDone that
    // arrives while a line is in flight. Passed on after the line, it would
    // read as the reply to it and put the script one turn ahead of the model.
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({ type: "AgentAudioDone" });
    h.transport.sendCalleeText("Are you still there?");
    vi.advanceTimersByTime(10 * DEEPGRAM_TURN_QUIET_MS);
    expect(h.events.filter((e) => e === "complete")).toEqual([]);
    // The reply to the line ends its own turn as usual.
    socket.agentSays({ type: "ConversationText", role: "user", content: "Are you still there?" });
    socket.agentSays({ type: "AgentAudioDone" });
    quiet();
    expect(h.events.filter((e) => e === "complete")).toEqual(["complete"]);
  });

  // The bytes are discarded; the fact that the model produced audio is what
  // ToolGate's confirmation rule on a completed record decides on.
  it("reports agent audio as a content-free event and discards its bytes", async () => {
    const h = harness();
    const socket = await h.connected();
    socket.emit("message", Buffer.from([0xff, 0x7f]), true);
    expect(h.events).toEqual(["audio"]);
  });

  it("surfaces a FunctionCallRequest as a tool call, skipping server-side functions", async () => {
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({
      type: "FunctionCallRequest",
      functions: [
        { id: "f1", name: "press_digits", arguments: '{"digits":"1"}', client_side: true },
        { id: "f2", name: "lookup", arguments: "{}", client_side: false }
      ]
    });
    expect(h.events).toEqual(['tool:f1:press_digits:{"digits":"1"}']);
  });

  it("answers with FunctionCallResponse carrying the ToolResult string", async () => {
    const h = harness();
    const socket = await h.connected();
    h.transport.sendToolResponse({ id: "f1", name: "press_digits", args: {} }, "ok");
    expect(socket.sent.at(-1)).toEqual({
      type: "FunctionCallResponse",
      id: "f1",
      name: "press_digits",
      content: "ok"
    });
  });

  it("ends the session on a refused injection — the line was never heard", async () => {
    // The runner has already counted the line as delivered: advanced its
    // cursor, recorded it as heard, anchored consent on it. Carrying on would
    // score the model on a line it never received, so the run ends through the
    // same path as a dead session, a scored non-model outcome.
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({ type: "InjectionRefused", message: "agent is speaking" });
    expect(h.events).toEqual(["closed:InjectionRefused: agent is speaking"]);
    // The close that follows is not reported a second time.
    await h.transport.close();
    expect(h.events).toHaveLength(1);
  });

  it("separates one utterance from the next, so numbers cannot run together", async () => {
    // Each ConversationText is a whole utterance with no trailing space.
    // Joined bare, "it's 160" and "8am works" read as "1608am".
    const h = harness();
    const socket = await h.connected();
    socket.agentSays({ type: "ConversationText", role: "assistant", content: "It's 160" });
    socket.agentSays({ type: "AgentAudioDone" });
    quiet();
    socket.agentSays({ type: "ConversationText", role: "assistant", content: "8am works." });
    expect(h.events).toEqual(["text:It's 160", "complete", "text: 8am works."]);
  });

  it("reports a session that closes underneath the run, but not its own close", async () => {
    const h = harness();
    const socket = await h.connected();
    socket.emit("close", 1011, Buffer.from("internal"));
    expect(h.events).toEqual(["closed:deepgram agent closed: code=1011 reason=internal"]);

    const h2 = harness();
    const socket2 = await h2.connected();
    await h2.transport.close();
    expect(socket2.closedByClient).toBe(true);
    expect(h2.events).toEqual([]);
  });

  it("never sends a re-instruction or an agent-voiced message", async () => {
    // InjectAgentMessage is spoken verbatim by TTS, bypassing the model; any
    // Update* is a mid-session re-instruction. Neither has a place here.
    const h = harness();
    const socket = await h.connected();
    h.transport.sendCalleeText("hello");
    socket.agentSays({
      type: "FunctionCallRequest",
      functions: [{ id: "f1", name: "press_digits", arguments: "{}", client_side: true }]
    });
    h.transport.sendToolResponse({ id: "f1", name: "press_digits", args: {} }, "ok");
    await h.transport.close();
    const types = socket.sent.map((m) => m.type);
    expect(types).toEqual(["Settings", "InjectUserMessage", "FunctionCallResponse"]);
  });
});

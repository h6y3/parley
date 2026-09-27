import { describe, expect, it } from "vitest";
// Imported (per the brief's Step 2 test body, verbatim) to prove
// `createDeepgramRealtimeProvider` is a real export of ../src/index.js —
// construction itself happens inside helpers.ts's connectProvider, so this
// binding is otherwise unused here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { createDeepgramRealtimeProvider } from "../src/index.js";
import { FakeAgentSocket, connectProvider } from "./helpers.js";

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

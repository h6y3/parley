import { describe, expect, it } from "vitest";
import { MEETING_CONNECTED_CUE, type TranscriptEvent } from "@parley/core";
import { FakeAgentSocket, connectProvider } from "./helpers.js";

/** Deepgram echoes every `InjectUserMessage` back as
 * `ConversationText(role: "user")`. On a meeting the one line injected is
 * `MEETING_CONNECTED_CUE`, so without this the cue reached the transcript —
 * and the pre-consent buffer the consent gate reads — as something a
 * participant said. */
describe("the echo of an injected line", () => {
  async function meeting() {
    const socket = new FakeAgentSocket();
    const transcripts: TranscriptEvent[] = [];
    const diagnostics: string[] = [];
    const session = await connectProvider(socket, {
      speakerRole: "participant",
      onTranscript: (e) => transcripts.push(e),
      onDiagnostic: (m) => diagnostics.push(m)
    });
    return { socket, session, transcripts, diagnostics };
  }

  it("is dropped, not reported as participant speech, with a content-free diagnostic", async () => {
    const { socket, session, transcripts, diagnostics } = await meeting();
    session.sendOpeningTrigger(MEETING_CONNECTED_CUE);
    socket.emitAgent({ type: "ConversationText", role: "user", content: MEETING_CONNECTED_CUE });

    expect(transcripts).toEqual([]);
    expect(diagnostics).toContain("deepgram dropped the echo of an injected line");
    for (const d of diagnostics) expect(d).not.toContain(MEETING_CONNECTED_CUE);
  });

  it("drops only the first matching echo: a participant saying the same words later is heard", async () => {
    const { socket, session, transcripts } = await meeting();
    session.sendOpeningTrigger(MEETING_CONNECTED_CUE);
    socket.emitAgent({ type: "ConversationText", role: "user", content: MEETING_CONNECTED_CUE });
    socket.emitAgent({ type: "ConversationText", role: "user", content: MEETING_CONNECTED_CUE });

    expect(transcripts).toEqual([
      { speaker: "participant", text: MEETING_CONNECTED_CUE, isFinal: true }
    ]);
  });

  it("leaves real participant speech alone while an echo is still pending", async () => {
    const { socket, session, transcripts } = await meeting();
    session.sendOpeningTrigger(MEETING_CONNECTED_CUE);
    socket.emitAgent({ type: "ConversationText", role: "user", content: "Who is this?" });
    socket.emitAgent({ type: "ConversationText", role: "user", content: MEETING_CONNECTED_CUE });

    expect(transcripts).toEqual([{ speaker: "participant", text: "Who is this?", isFinal: true }]);
  });

  it("never drops an assistant utterance with the same text", async () => {
    const { socket, session, transcripts } = await meeting();
    session.sendOpeningTrigger(MEETING_CONNECTED_CUE);
    socket.emitAgent({
      type: "ConversationText",
      role: "assistant",
      content: MEETING_CONNECTED_CUE
    });

    expect(transcripts).toEqual([{ speaker: "model", text: MEETING_CONNECTED_CUE, isFinal: true }]);
  });

  it("drops nothing when nothing was injected", async () => {
    const { socket, transcripts } = await meeting();
    socket.emitAgent({ type: "ConversationText", role: "user", content: MEETING_CONNECTED_CUE });

    expect(transcripts).toEqual([
      { speaker: "participant", text: MEETING_CONNECTED_CUE, isFinal: true }
    ]);
  });
});

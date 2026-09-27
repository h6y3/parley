import { describe, expect, it } from "vitest";
import { CallSession } from "../src/call-session.js";
import {
  FakeSocket,
  fakes,
  makeMeetingFakes,
  makeSessionParams
} from "./helpers/call-session-harness.js";

/**
 * `RealtimeConnectParams.speakerRole` (design spec's component table) tags
 * the far end at SOURCE: `"participant"` on a declared meeting, `"caller"`
 * (the pre-existing default) on an ordinary two-party call. Nothing
 * downstream should have to infer which kind of call produced a transcript
 * event from context.
 *
 * The trap this guards: `CallSession`'s far-end branch in `onTranscript`
 * used to be keyed to the literal `"caller"` tag. Tagging a meeting's far end
 * `"participant"` without widening that branch stops it firing at all on a
 * meeting call — a participant's words then fall through into the
 * model-fragment COALESCING path and get recorded as though the agent said
 * them. Every test below that drives a "participant" event through the real
 * `onTranscript` callback is checking for exactly that failure mode, not just
 * checking the tag.
 */
describe("RealtimeConnectParams.speakerRole", () => {
  it("is absent (defaults to caller) on an ordinary two-party call", async () => {
    const f = fakes();
    const cs = new CallSession({
      ...makeSessionParams(),
      telephony: f.telephony,
      realtime: f.realtime
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    expect(f.getConnectParams().speakerRole).toBeUndefined();
  });

  it("is 'participant' on a declared meeting call", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    expect(f.getConnectParams().speakerRole).toBe("participant");
  });

  it("routes a meeting's pre-consent PARTICIPANT utterance through the far-end branch, not the model-fragment coalescing path", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    // Open a model entry with a partial fragment — the state the coalescing
    // path mutates in place.
    f.emitTranscript({ speaker: "model", text: "Hi there", isFinal: false });

    // The far end speaks, tagged as the meeting path now tags it.
    f.emitTranscript({
      speaker: "participant",
      text: "go ahead and take notes",
      isFinal: true
    });

    // If the far-end branch fired (correct), the participant's words landed
    // in the pre-consent buffer as their OWN entry, untouched by the open
    // model fragment: heardBeforeConsent (which excludes "model" entries)
    // reads back exactly the participant's text.
    //
    // Under the bug this guards (branch keyed to the literal "caller" tag),
    // the "participant" event instead falls into the coalescing path: it is
    // appended onto the open model fragment ("Hi there" + "go ahead and take
    // notes") and the merged result is pushed to the pre-consent buffer
    // tagged "model" — heardBeforeConsent would then read back EMPTY, since
    // it excludes model entries. That divergence is what this assertion
    // catches.
    expect(cs.heardBeforeConsent).toEqual(["go ahead and take notes"]);
  });

  it("still routes an ordinary call's caller utterance through the far-end branch (regression guard)", async () => {
    const f = fakes();
    const cs = new CallSession({
      ...makeSessionParams(),
      telephony: f.telephony,
      realtime: f.realtime
    });
    await cs.originate();
    const handle = await cs.attach("call-1", new FakeSocket());

    f.emitTranscript({ speaker: "model", text: "Hi there", isFinal: false });
    f.emitTranscript({ speaker: "caller", text: "hello back", isFinal: true });
    f.emitTurnComplete();

    expect(handle.transcript.map((e) => ({ speaker: e.speaker, text: e.text }))).toEqual([
      { speaker: "model", text: "Hi there" },
      { speaker: "caller", text: "hello back" }
    ]);
  });

  it("produces a consent receipt whose go-ahead is attributed to 'participant', agreeing with the committed meeting fixture", async () => {
    const f = makeMeetingFakes();
    const cs = new CallSession(f.params);
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    f.emitTranscript({
      speaker: "model",
      text: "Hi everyone — I'm an AI assistant on the line, here to take notes.",
      isFinal: true
    });
    f.emitTurnComplete();
    f.emitTranscript({ speaker: "model", text: "Any objection to my doing that?", isFinal: true });
    f.emitTurnComplete();
    f.emitTranscript({
      speaker: "participant",
      text: "Sure, go ahead and take notes.",
      isFinal: true
    });

    await cs.beginNotetaking();

    const receipt = cs.consentReceipt;
    expect(receipt?.utterances.at(-1)).toEqual({
      speaker: "participant",
      text: "Sure, go ahead and take notes."
    });
  });
});

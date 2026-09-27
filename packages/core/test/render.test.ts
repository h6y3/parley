import { describe, expect, it } from "vitest";
import {
  MEETING_OPENING_TRIGGER,
  OPENING_TRIGGER,
  renderSystemInstruction
} from "../src/render.js";

describe("renderSystemInstruction", () => {
  it("orders persona, objective+facts, guardrails and joins with blank lines", () => {
    const out = renderSystemInstruction({
      persona: "  You are Ada.  ",
      objective: "  Confirm the 7pm booking.  ",
      facts: ["Party of four.", "Friday."],
      guardrails: ["Rule one.", "Rule two."]
    });
    expect(out).toBe(
      "You are Ada.\n\nConfirm the 7pm booking. Party of four. Friday.\n\nRule one. Rule two."
    );
  });

  it("omits the guardrails section entirely when there are none", () => {
    const out = renderSystemInstruction({
      persona: "P",
      objective: "O",
      facts: [],
      guardrails: []
    });
    expect(out).toBe("P\n\nO");
  });

  it("omits the objective/facts section when both are empty", () => {
    const out = renderSystemInstruction({
      persona: "P",
      objective: "",
      facts: [],
      guardrails: ["G."]
    });
    expect(out).toBe("P\n\nG.");
  });
});

/**
 * The trigger tells the model to wait before speaking. Told only that, a live
 * call had it narrate the wait — the transcript carries "(waiting for someone
 * or something to speak first)" and "(I'm waiting silently for any menu or
 * person to continue.)" in the MODEL channel, meaning a person who had just
 * picked up the phone heard them.
 *
 * On a voice call every instruction is about audible behaviour, so one that
 * describes a state has to say what that state sounds like.
 */
describe("OPENING_TRIGGER", () => {
  it("says waiting means silence, not announcing the wait", () => {
    expect(OPENING_TRIGGER).toMatch(/Waiting means silence/);
    expect(OPENING_TRIGGER).toMatch(/do not announce that you are waiting/);
    expect(OPENING_TRIGGER).toMatch(/do not narrate your own state/);
  });

  it("gives the reason it matters here specifically", () => {
    expect(OPENING_TRIGGER).toMatch(/heard aloud by whoever picks up/);
  });

  it("still says what to do once something is heard", () => {
    expect(OPENING_TRIGGER).toMatch(/greet a person and say why you are calling/);
  });
});

/**
 * Two live meeting calls were sent `OPENING_TRIGGER`. On both the model took
 * its turns (`modelTurnsCompleted` 2 and 1), said nothing, never called
 * `begin_notetaking`, and the call ended `consent_refused` with no transcript.
 *
 * These assert PROPERTIES rather than the literal sentence, so the wording can
 * be tuned against the next live call without any of them being lost silently
 * — which is exactly how the defect survived: nothing anywhere asserted that
 * the instruction a meeting receives ever tells the model to speak.
 */
describe("MEETING_OPENING_TRIGGER", () => {
  it("is one line, and is not the generic trigger", () => {
    expect(MEETING_OPENING_TRIGGER).not.toContain("\n");
    expect(MEETING_OPENING_TRIGGER).not.toBe(OPENING_TRIGGER);
  });

  it("states the one thing the model cannot observe — nothing has been heard yet", () => {
    expect(MEETING_OPENING_TRIGGER).toMatch(/just connected and nothing has been heard yet/);
  });

  it("classifies what a bridge sounds like before it starts as the meeting not having begun", () => {
    expect(MEETING_OPENING_TRIGGER).toMatch(/[Hh]old music/);
    expect(MEETING_OPENING_TRIGGER).toMatch(/waiting for the host/);
    expect(MEETING_OPENING_TRIGGER).toMatch(/silence/);
    expect(MEETING_OPENING_TRIGGER).toMatch(/the meeting has not begun/);
  });

  it("says waiting means silence and no keypress, and is not narrated", () => {
    expect(MEETING_OPENING_TRIGGER).toMatch(/say nothing, press nothing/);
    expect(MEETING_OPENING_TRIGGER).toMatch(/do not narrate that you are waiting/);
  });

  // The whole point of the constant: hearing the room is PERMISSION TO SPEAK,
  // not one more reason to wait. Without this the trigger is a third
  // instruction pointing at silence, alongside the two meeting rails that
  // legitimately do.
  it("makes hearing the room the cue to speak, not another reason to wait", () => {
    expect(MEETING_OPENING_TRIGGER).toMatch(/hear people talking to one another/);
    expect(MEETING_OPENING_TRIGGER).toMatch(/the waiting is over/);
    expect(MEETING_OPENING_TRIGGER).toMatch(/say once who you are and why you are here/);
    expect(MEETING_OPENING_TRIGGER).toMatch(/take notes/);
  });

  // `meetingConsentRequest` (@parley/policy) records a live call where a
  // negative-polarity ask — "are any of you unhappy with that?" — was granted
  // with a bare "no", the one answer the consent gate cannot accept. A trigger
  // asking the same question the other way round would fight the rail it hands
  // over to.
  it("asks for consent positively, never as an objection", () => {
    expect(MEETING_OPENING_TRIGGER).toMatch(/whether it is all right/);
    expect(MEETING_OPENING_TRIGGER).not.toMatch(/object/i);
  });

  // Greeting a person and stating a purpose, or working a phone tree, belong
  // to the two-party trigger. Carried into a meeting they are what made the
  // instruction unactionable in the first place.
  it("carries no transactional or IVR framing", () => {
    expect(MEETING_OPENING_TRIGGER).not.toMatch(/why you are calling/i);
    expect(MEETING_OPENING_TRIGGER).not.toMatch(/menu/i);
    expect(MEETING_OPENING_TRIGGER).not.toMatch(/recording/i);
  });
});

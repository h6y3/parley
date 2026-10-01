import { describe, expect, it, vi } from "vitest";
import {
  MEETING_OPENING_TRIGGER,
  OPENING_TRIGGER,
  isoDate,
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

describe("renderSystemInstruction today", () => {
  const base = { persona: "P", objective: "O", facts: [], guardrails: ["G."] };
  // Changed 2026-09-30: the sentence now ends with the next 14 days, so the
  // helper takes the list it ends with.
  const sentence = (day: string, zone: string, next: string): string =>
    `Today is ${day} (${zone}). When the other person gives a relative date such as "tomorrow" or "next Tuesday", work out the calendar date from today before you record it. The next 14 days are: ${next}. When you say a date, use the weekday and date together exactly as listed.`;
  const FROM_OCT_1 =
    "Thu Oct 1, Fri Oct 2, Sat Oct 3, Sun Oct 4, Mon Oct 5, Tue Oct 6, Wed Oct 7, Thu Oct 8, " +
    "Fri Oct 9, Sat Oct 10, Sun Oct 11, Mon Oct 12, Tue Oct 13, Wed Oct 14";
  const FROM_OCT_2 =
    "Fri Oct 2, Sat Oct 3, Sun Oct 4, Mon Oct 5, Tue Oct 6, Wed Oct 7, Thu Oct 8, Fri Oct 9, " +
    "Sat Oct 10, Sun Oct 11, Mon Oct 12, Tue Oct 13, Wed Oct 14, Thu Oct 15";

  it("appends the exact sentence in America/Los_Angeles", () => {
    const out = renderSystemInstruction({
      ...base,
      today: { now: new Date("2026-09-30T19:00:00Z"), timeZone: "America/Los_Angeles" }
    });
    expect(out).toBe(
      `P\n\nO\n\nG.\n\n${sentence("Wednesday, 2026-09-30", "America/Los_Angeles", FROM_OCT_1)}`
    );
  });

  it("dates by the zone across a UTC boundary: one instant is two different days", () => {
    const now = new Date("2026-09-30T20:30:00Z");
    const la = renderSystemInstruction({
      ...base,
      today: { now, timeZone: "America/Los_Angeles" }
    });
    const tokyo = renderSystemInstruction({ ...base, today: { now, timeZone: "Asia/Tokyo" } });
    expect(la).toContain(sentence("Wednesday, 2026-09-30", "America/Los_Angeles", FROM_OCT_1));
    expect(tokyo).toContain(sentence("Thursday, 2026-10-01", "Asia/Tokyo", FROM_OCT_2));
  });

  /**
   * Live A/B, 2026-09-30: told "Today is Wednesday, 2026-09-30", one think model
   * resolved "next Tuesday" to October 7th on both calls (it is October 6).
   * Weekday arithmetic is exactly what a language model is bad at, so the
   * sentence hands it the calendar instead of asking it to compute one.
   */
  it("lists the 14 days after today, across a month boundary", () => {
    const out = renderSystemInstruction({
      ...base,
      today: { now: new Date("2026-09-25T19:00:00Z"), timeZone: "America/Los_Angeles" }
    });
    expect(out).toContain(
      "The next 14 days are: Sat Sep 26, Sun Sep 27, Mon Sep 28, Tue Sep 29, Wed Sep 30, " +
        "Thu Oct 1, Fri Oct 2, Sat Oct 3, Sun Oct 4, Mon Oct 5, Tue Oct 6, Wed Oct 7, Thu Oct 8, " +
        "Fri Oct 9."
    );
  });

  it("starts the list from the zone's tomorrow, not UTC's", () => {
    // 2026-10-01T03:00Z is still September 30 in Los Angeles: UTC's tomorrow
    // would wrongly start the list at Fri Oct 2.
    const out = renderSystemInstruction({
      ...base,
      today: { now: new Date("2026-10-01T03:00:00Z"), timeZone: "America/Los_Angeles" }
    });
    expect(out).toContain(sentence("Wednesday, 2026-09-30", "America/Los_Angeles", FROM_OCT_1));
  });

  it("crosses a year boundary and a DST change without skipping or repeating a day", () => {
    const out = renderSystemInstruction({
      ...base,
      today: { now: new Date("2026-12-25T18:00:00Z"), timeZone: "America/New_York" }
    });
    expect(out).toContain(
      "The next 14 days are: Sat Dec 26, Sun Dec 27, Mon Dec 28, Tue Dec 29, Wed Dec 30, " +
        "Thu Dec 31, Fri Jan 1 2027, Sat Jan 2 2027, Sun Jan 3 2027, Mon Jan 4 2027, " +
        "Tue Jan 5 2027, Wed Jan 6 2027, Thu Jan 7 2027, Fri Jan 8 2027."
    );
    const dst = renderSystemInstruction({
      ...base,
      // US clocks fall back on Sunday 2026-11-01.
      today: { now: new Date("2026-10-30T19:00:00Z"), timeZone: "America/Los_Angeles" }
    });
    expect(dst).toContain("The next 14 days are: Sat Oct 31, Sun Nov 1, Mon Nov 2, Tue Nov 3,");
    expect(dst).toContain("Thu Nov 12, Fri Nov 13.");
  });

  it("is byte-identical to the old output when today is absent", () => {
    expect(renderSystemInstruction(base)).toBe("P\n\nO\n\nG.");
  });
});

describe("isoDate", () => {
  it("reads the date in the given zone, not UTC's", () => {
    const now = new Date("2026-10-01T03:00:00Z");
    expect(isoDate(now, "America/Los_Angeles")).toBe("2026-09-30");
    expect(isoDate(now, "Asia/Tokyo")).toBe("2026-10-01");
    expect(isoDate(new Date("2027-01-01T00:30:00Z"), "UTC")).toBe("2027-01-01");
  });

  it("does not depend on a locale that prints ISO order (en-CA needs ICU data)", () => {
    const Real = Intl.DateTimeFormat;
    const locales: unknown[] = [];
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: function (l?: unknown, o?: Intl.DateTimeFormatOptions) {
        locales.push(l);
        return new Real(l as string, o);
      }
    });
    try {
      expect(isoDate(new Date("2026-10-01T12:00:00Z"), "UTC")).toBe("2026-10-01");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(locales.length).toBeGreaterThan(0);
    expect(locales).not.toContain("en-CA");
  });
});

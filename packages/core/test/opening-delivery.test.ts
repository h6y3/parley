import { describe, expect, it } from "vitest";
import { CallSession } from "../src/call-session.js";
import {
  MEETING_CONNECTED_CUE,
  MEETING_OPENING_TRIGGER,
  OPENING_TRIGGER,
  planOpening,
  withOpening
} from "../src/render.js";
import type {
  OpeningDelivery,
  OpeningDeliveryByShape,
  RealtimeConnectParams,
  RealtimeProvider
} from "../src/types.js";
import {
  brief,
  guardrails,
  fakeCanConvert,
  fakeCodec,
  fakeConvert,
  fakes,
  makeMeetingFakes,
  FakeSocket
} from "./helpers/call-session-harness.js";

/** Count non-overlapping occurrences — "appended exactly once" is the claim,
 * and `endsWith` alone would pass a prompt that carried it twice. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The same fake provider, re-declared with a different opening delivery.
 * Its `connect` is wrapped so the test reads the systemInstruction actually
 * sent, not the one `resolveSystemInstruction` would render. */
function withDelivery(
  realtime: RealtimeProvider,
  openingDelivery: OpeningDelivery | OpeningDeliveryByShape
): { provider: RealtimeProvider; connectParams: () => RealtimeConnectParams } {
  let captured: RealtimeConnectParams | undefined;
  return {
    provider: {
      ...realtime,
      openingDelivery,
      connect: (p) => {
        captured = p;
        return realtime.connect(p);
      }
    },
    connectParams: () => captured!
  };
}

describe("planOpening", () => {
  it.each([
    ["turn", false, { trigger: OPENING_TRIGGER }],
    ["turn", true, { trigger: MEETING_OPENING_TRIGGER }],
    ["prompt", false, { promptSuffix: OPENING_TRIGGER }],
    ["prompt", true, { promptSuffix: MEETING_OPENING_TRIGGER, trigger: MEETING_CONNECTED_CUE }]
  ] as const)("%s delivery, meeting=%s", (delivery, isMeeting, expected) => {
    expect(planOpening(delivery, isMeeting)).toEqual(expected);
  });

  /** A provider can declare each call shape separately — Gemini takes a
   * two-party opening in the prompt and a meeting's as a turn. Each shape is
   * planned exactly as the plain declaration of that shape would be. */
  it.each([
    [{ twoParty: "prompt", meeting: "turn" }, false, "prompt"],
    [{ twoParty: "prompt", meeting: "turn" }, true, "turn"],
    [{ twoParty: "turn", meeting: "prompt" }, false, "turn"],
    [{ twoParty: "turn", meeting: "prompt" }, true, "prompt"]
  ] as const)("%o, meeting=%s plans as %s", (byShape, isMeeting, same) => {
    expect(planOpening(byShape, isMeeting)).toEqual(planOpening(same, isMeeting));
  });

  it("never carries caller content: every text it returns is a Parley constant", () => {
    const constants = new Set([OPENING_TRIGGER, MEETING_OPENING_TRIGGER, MEETING_CONNECTED_CUE]);
    for (const delivery of ["turn", "prompt"] as const) {
      for (const isMeeting of [false, true]) {
        const plan = planOpening(delivery, isMeeting);
        for (const text of [plan.promptSuffix, plan.trigger]) {
          if (text !== undefined) expect(constants.has(text)).toBe(true);
        }
      }
    }
  });
});

describe("MEETING_CONNECTED_CUE", () => {
  it("is one short line", () => {
    expect(MEETING_CONNECTED_CUE).not.toContain("\n");
    expect(MEETING_CONNECTED_CUE.length).toBeLessThanOrEqual(80);
    expect(MEETING_CONNECTED_CUE.length).toBeGreaterThan(0);
  });
});

describe("CallSession opening delivery", () => {
  // The clock and zone are pinned so the date sentence every call now carries
  // is a known string: 2026-09-30 in Los Angeles is a Wednesday.
  const clock = { now: () => Date.UTC(2026, 8, 30, 19, 0, 0), timeZone: "America/Los_Angeles" };
  const rendered =
    "You are Ada.\n\nConfirm the booking. Party of four.\n\nRule one. Rule two.\n\n" +
    'Today is Wednesday, 2026-09-30 (America/Los_Angeles). When the other person gives a relative date such as "tomorrow" or "next Tuesday", work out the calendar date from today before you record it. The next 14 days are: Thu Oct 1, Fri Oct 2, Sat Oct 3, Sun Oct 4, Mon Oct 5, Tue Oct 6, Wed Oct 7, Thu Oct 8, Fri Oct 9, Sat Oct 10, Sun Oct 11, Mon Oct 12, Tue Oct 13, Wed Oct 14. When you say a date, use the weekday and date together exactly as listed.';

  it('"prompt", two-party: nothing is injected, and the prompt ends with OPENING_TRIGGER exactly once', async () => {
    const f = fakes();
    const p = withDelivery(f.realtime, "prompt");
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: p.provider,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model",
      ...clock
    });
    await cs.attach("call-1", new FakeSocket());

    const instruction = p.connectParams().systemInstruction;
    expect(instruction).toBe(`${rendered}\n\n${OPENING_TRIGGER}`);
    expect(occurrences(instruction, OPENING_TRIGGER)).toBe(1);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it('"prompt", meeting: sends exactly MEETING_CONNECTED_CUE, and the prompt ends with MEETING_OPENING_TRIGGER once', async () => {
    const f = makeMeetingFakes();
    const p = withDelivery(f.params.realtime, "prompt");
    const cs = new CallSession({ ...f.params, realtime: p.provider });
    await cs.attach("CA1", new FakeSocket());

    const instruction = p.connectParams().systemInstruction;
    expect(instruction.endsWith(`\n\n${MEETING_OPENING_TRIGGER}`)).toBe(true);
    expect(occurrences(instruction, MEETING_OPENING_TRIGGER)).toBe(1);
    expect(instruction).not.toContain(OPENING_TRIGGER);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(MEETING_CONNECTED_CUE);
  });

  it("per-shape declaration: a two-party call takes the twoParty delivery", async () => {
    const f = fakes();
    const p = withDelivery(f.realtime, { twoParty: "prompt", meeting: "turn" });
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: p.provider,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model",
      ...clock
    });
    expect(cs.resolveSystemInstruction()).toBe(`${rendered}\n\n${OPENING_TRIGGER}`);
    await cs.attach("call-1", new FakeSocket());
    expect(p.connectParams().systemInstruction).toBe(`${rendered}\n\n${OPENING_TRIGGER}`);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it('per-shape declaration: a meeting takes the meeting delivery, exactly as a plain "turn" provider\'s', async () => {
    const plain = makeMeetingFakes();
    const plainP = withDelivery(plain.params.realtime, "turn");
    await new CallSession({ ...plain.params, realtime: plainP.provider }).attach(
      "CA1",
      new FakeSocket()
    );

    const f = makeMeetingFakes();
    const p = withDelivery(f.params.realtime, { twoParty: "prompt", meeting: "turn" });
    await new CallSession({ ...f.params, realtime: p.provider }).attach("CA1", new FakeSocket());

    expect(p.connectParams().systemInstruction).toBe(plainP.connectParams().systemInstruction);
    expect(p.connectParams().systemInstruction).not.toContain(MEETING_OPENING_TRIGGER);
    expect(f.openingTrigger.mock.calls).toEqual(plain.openingTrigger.mock.calls);
    expect(f.openingTrigger.mock.calls).toEqual([[MEETING_OPENING_TRIGGER]]);
  });

  it('"turn": the prompt is the rendered brief alone and the trigger goes as a turn, as before', async () => {
    const f = fakes();
    const p = withDelivery(f.realtime, "turn");
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: p.provider,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model",
      ...clock
    });
    await cs.attach("call-1", new FakeSocket());

    expect(p.connectParams().systemInstruction).toBe(rendered);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(OPENING_TRIGGER);
  });

  // What it returns is what goes on the wire — never a prompt that differs
  // from the one the model was actually given.
  it.each(["turn", "prompt"] as const)(
    "resolveSystemInstruction is exactly the prompt sent at connect (%s delivery)",
    async (delivery) => {
      const f = fakes();
      const p = withDelivery(f.realtime, delivery);
      const cs = new CallSession({
        brief,
        guardrails,
        telephony: f.telephony,
        realtime: p.provider,
        codec: fakeCodec,
        convert: fakeConvert,
        canConvert: fakeCanConvert,
        from: "+14155550000",
        answerWebhookUrl: "https://example.test/answer",
        model: "test-model",
        ...clock
      });
      const resolved = cs.resolveSystemInstruction();
      await cs.attach("call-1", new FakeSocket());
      expect(resolved).toBe(p.connectParams().systemInstruction);
      expect(resolved).toBe(delivery === "prompt" ? `${rendered}\n\n${OPENING_TRIGGER}` : rendered);
    }
  );
});

describe("withOpening", () => {
  it("appends a prompt suffix after a blank line, and nothing without one", () => {
    expect(withOpening("Base.", { promptSuffix: "Suffix." })).toBe("Base.\n\nSuffix.");
    expect(withOpening("Base.", { trigger: "Line." })).toBe("Base.");
  });
});

describe("CallSession today", () => {
  it("sends the date sentence exactly once, before the opening suffix, from the injected clock", async () => {
    const f = fakes();
    const p = withDelivery(f.realtime, "prompt");
    const cs = new CallSession({
      brief,
      guardrails,
      telephony: f.telephony,
      realtime: p.provider,
      codec: fakeCodec,
      convert: fakeConvert,
      canConvert: fakeCanConvert,
      from: "+14155550000",
      answerWebhookUrl: "https://example.test/answer",
      model: "test-model",
      now: () => Date.UTC(2026, 8, 30, 20, 30, 0),
      timeZone: "Asia/Tokyo"
    });
    await cs.attach("call-1", new FakeSocket());

    const instruction = p.connectParams().systemInstruction;
    expect(occurrences(instruction, "Today is Thursday, 2026-10-01 (Asia/Tokyo).")).toBe(1);
    expect(instruction.indexOf("Today is")).toBeLessThan(instruction.indexOf(OPENING_TRIGGER));
  });
});

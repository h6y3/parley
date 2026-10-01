import { describe, expect, it } from "vitest";
import { CallSession } from "../src/call-session.js";
import { brief, FakeSocket, fakes, makeSessionParams } from "./helpers/call-session-harness.js";

/** `brief.keyterms` is a speech-recognition hint (a name the listener would
 * otherwise mishear), not something the model is told. It travels to the
 * provider as `RealtimeConnectParams.keyterms` and never into the one-shot
 * system instruction. */
describe("Brief.keyterms", () => {
  it("is passed to the realtime provider as connect params keyterms", async () => {
    const f = fakes();
    const cs = new CallSession({
      ...makeSessionParams(),
      brief: { ...brief, keyterms: ["Nguyen", "Parley"] },
      telephony: f.telephony,
      realtime: f.realtime
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    expect(f.getConnectParams().keyterms).toEqual(["Nguyen", "Parley"]);
  });

  it("is absent from connect params when the brief carries none", async () => {
    const f = fakes();
    const cs = new CallSession({
      ...makeSessionParams(),
      telephony: f.telephony,
      realtime: f.realtime
    });
    await cs.originate();
    await cs.attach("call-1", new FakeSocket());

    expect("keyterms" in f.getConnectParams()).toBe(false);
  });

  it("never changes the rendered system instruction", () => {
    const without = new CallSession(makeSessionParams()).resolveSystemInstruction();
    const withTerms = new CallSession({
      ...makeSessionParams(),
      brief: { ...brief, keyterms: ["Nguyen"] }
    }).resolveSystemInstruction();
    expect(withTerms).toBe(without);
    expect(withTerms).not.toContain("Nguyen");
  });
});

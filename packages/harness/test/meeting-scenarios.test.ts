import { describe, expect, it } from "vitest";
import { MEETING_SCENARIOS } from "../src/scenarios.js";

describe("MEETING_SCENARIOS", () => {
  it("covers every way the join can go wrong", () => {
    expect(MEETING_SCENARIOS.map((s) => s.id).sort()).toEqual([
      "consent-phrase-by-a-stranger",
      "consent-phrase-quoted-early",
      "consent-refused",
      "hold-music",
      "host-removes-agent",
      "someone-addresses-the-agent-after-consent",
      "waiting-room-then-host"
    ]);
  });

  it("gives every scenario a line a recorded fixture can say verbatim, except silence", () => {
    for (const s of MEETING_SCENARIOS) {
      expect(s.description.length).toBeGreaterThan(20);
      if (s.id !== "hold-music") expect(s.calleeLine.length).toBeGreaterThan(0);
    }
  });
});

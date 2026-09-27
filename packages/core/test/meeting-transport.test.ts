import { describe, expect, it } from "vitest";
import {
  consentIsSpoken,
  DEFAULT_MEETING_TRANSPORT,
  MEETING_TRANSPORTS,
  SPOKEN_CONSENT_TRANSPORTS
} from "../src/meeting.js";

/** `transport` replaced a proxy: the record's consent invariant used to read
 * the presence of `joinOutcome` as a stand-in for "consent is not spoken
 * here". These are the facts that proxy was standing in for, so they are
 * asserted directly rather than through a record that happens to exercise
 * them. */
describe("meeting transports", () => {
  it("names both transports a record can be conducted over", () => {
    expect([...MEETING_TRANSPORTS]).toEqual(["telephony", "browser"]);
  });

  it("reads an absent transport as telephony, which keeps every earlier record valid", () => {
    // Not "unknown": telephony is the only transport that existed when every
    // record without the field was written.
    expect(DEFAULT_MEETING_TRANSPORT).toBe("telephony");
    expect(consentIsSpoken(undefined)).toBe(true);
  });

  it("requires a spoken consent exchange on telephony and not in a browser", () => {
    expect(consentIsSpoken("telephony")).toBe(true);
    // Admitted under a caller-supplied display name, which IS the disclosure.
    // There is no spoken exchange, so there is no receipt of one to demand.
    expect(consentIsSpoken("browser")).toBe(false);
  });

  it("declares no spoken-consent transport that is not a transport", () => {
    for (const transport of SPOKEN_CONSENT_TRANSPORTS) {
      expect(MEETING_TRANSPORTS).toContain(transport);
    }
  });
});

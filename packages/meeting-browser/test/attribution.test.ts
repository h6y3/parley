import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "@parley/core";
import { attributeEvents } from "../src/attribution.js";

const ev = (startMs: number, text: string): TranscriptEvent => ({
  speaker: "participant",
  text,
  startMs,
  isFinal: true
});

describe("attributeEvents", () => {
  it("attributes an utterance to the caption cue nearest its start", () => {
    const out = attributeEvents(
      [ev(10_000, "the deadline slipped")],
      [{ speaker: "Priya", text: "the deadline slipped", atMs: 10_200 }]
    );
    expect(out[0].speakerId).toBe("Priya");
    expect(out[0].speakerSource).toBe("roster");
  });

  it("leaves an utterance unattributed when no cue is near it", () => {
    const out = attributeEvents(
      [ev(10_000, "the deadline slipped")],
      [{ speaker: "Priya", text: "unrelated", atMs: 99_000 }]
    );
    expect(out[0].speakerId).toBeUndefined();
    expect(out[0].speakerSource).toBeUndefined();
  });

  it("never invents attribution when there are no cues at all", () => {
    // Captions being unavailable must cost attribution and nothing else.
    const out = attributeEvents([ev(1, "a"), ev(2, "b")], []);
    expect(out.map((e) => e.speakerId)).toEqual([undefined, undefined]);
    expect(out.map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("marks attribution as inferred, never as certain", () => {
    const out = attributeEvents([ev(10_000, "x")], [{ speaker: "Priya", text: "x", atMs: 10_000 }]);
    // speakerConfidence present at all is the claim that this was INFERRED.
    // Caption-derived attribution is not diarization and must not read as it.
    expect(out[0].speakerConfidence).toBeGreaterThan(0);
    expect(out[0].speakerConfidence).toBeLessThan(1);
  });

  it("does not mutate its inputs", () => {
    const events = [ev(10_000, "x")];
    attributeEvents(events, [{ speaker: "Priya", text: "x", atMs: 10_000 }]);
    expect(events[0].speakerId).toBeUndefined();
  });

  it("breaks a tie between two equidistant cues by preferring the earlier one, independent of input order", () => {
    // Event at 10_000. One cue 200ms before it, one cue 200ms after — same
    // |delta| either way. The earlier cue (by atMs) must win regardless of
    // which order the caller happens to pass the cues in — that is the
    // contract, not an accident of array order.
    const earlier = { speaker: "Priya", text: "earlier", atMs: 9_800 };
    const later = { speaker: "Sam", text: "later", atMs: 10_200 };

    const forward = attributeEvents([ev(10_000, "the deadline slipped")], [earlier, later]);
    const reversed = attributeEvents([ev(10_000, "the deadline slipped")], [later, earlier]);

    expect(forward[0].speakerId).toBe("Priya");
    expect(reversed[0].speakerId).toBe("Priya");
  });
});

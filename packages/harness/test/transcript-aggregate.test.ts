import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "@parley/core";
import { aggregateTranscript } from "../src/transcript.js";

describe("aggregateTranscript", () => {
  it("concatenates append-only deltas verbatim (Gemini shape)", () => {
    const events: TranscriptEvent[] = [
      { speaker: "model", text: "Hi, ", isFinal: false },
      { speaker: "model", text: "this is Ava.", isFinal: true }
    ];
    expect(aggregateTranscript(events)).toEqual([{ speaker: "model", text: "Hi, this is Ava." }]);
  });

  it("REPLACES rather than appends when events share a segmentId (Deepgram shape)", () => {
    const events: TranscriptEvent[] = [
      { speaker: "participant", segmentId: "s1", text: "the", isFinal: false },
      { speaker: "participant", segmentId: "s1", text: "the quick", isFinal: false },
      { speaker: "participant", segmentId: "s1", text: "the quick brown", isFinal: true }
    ];
    expect(aggregateTranscript(events)).toEqual([
      { speaker: "participant", text: "the quick brown" }
    ]);
  });

  it("starts a new utterance when the segmentId changes", () => {
    const events: TranscriptEvent[] = [
      { speaker: "participant", segmentId: "s1", text: "first", isFinal: true },
      { speaker: "participant", segmentId: "s2", text: "second", isFinal: true }
    ];
    expect(aggregateTranscript(events)).toEqual([
      { speaker: "participant", text: "first" },
      { speaker: "participant", text: "second" }
    ]);
  });

  it("closes a turn when speakerId changes even though the role does not", () => {
    const events: TranscriptEvent[] = [
      { speaker: "participant", speakerId: "S1", text: "we should ship it", isFinal: true },
      { speaker: "participant", speakerId: "S2", text: "agreed", isFinal: true }
    ];
    expect(aggregateTranscript(events)).toEqual([
      { speaker: "participant", speakerId: "S1", text: "we should ship it" },
      { speaker: "participant", speakerId: "S2", text: "agreed" }
    ]);
  });
});

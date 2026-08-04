import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "@parley/core";
import { aggregateTranscript } from "../src/transcript.js";

const ev = (speaker: "caller" | "model", text: string, isFinal = false): TranscriptEvent => ({
  speaker,
  text,
  isFinal
});

describe("aggregateTranscript", () => {
  it("concatenates same-speaker deltas (no separator) and closes a turn on isFinal", () => {
    const events = [ev("model", "Hi, "), ev("model", "how can "), ev("model", "I help?"), ev("model", "", true)];
    expect(aggregateTranscript(events)).toEqual([{ speaker: "model", text: "Hi, how can I help?" }]);
  });

  it("separates consecutive turns and preserves speaker", () => {
    const events = [
      ev("model", "One."),
      ev("model", "", true),
      ev("caller", "A "),
      ev("caller", "question.", true),
      ev("model", "Two.", true)
    ];
    expect(aggregateTranscript(events)).toEqual([
      { speaker: "model", text: "One." },
      { speaker: "caller", text: "A question." },
      { speaker: "model", text: "Two." }
    ]);
  });

  it("closes a dangling turn with no trailing isFinal", () => {
    expect(aggregateTranscript([ev("model", "unterminated")])).toEqual([{ speaker: "model", text: "unterminated" }]);
  });
});

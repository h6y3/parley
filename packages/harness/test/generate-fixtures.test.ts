import { describe, expect, it, vi } from "vitest";
import { generateFixtures } from "../src/generate-fixtures.js";
import { DERAIL_SCENARIOS, MEETING_SCENARIOS } from "../src/scenarios.js";
import { samplesToPcm16Buffer } from "@parley/audio";

describe("generateFixtures", () => {
  it("writes one 16kHz fixture per non-silence scenario and skips silence", async () => {
    const writes: Record<string, Buffer> = {};
    // Fake TTS returns a 24kHz tone; the writer must resample to 16kHz.
    const synth = vi.fn(async () => ({
      sampleRate: 24000,
      pcm: samplesToPcm16Buffer(new Int16Array(2400).fill(4000))
    }));
    const writeFile = vi.fn((path: string, data: Buffer) => {
      writes[path] = data;
    });

    const written = await generateFixtures({ outDir: "/out" }, { synthesize: synth, writeFile });

    // Every scenario with a spoken line, from BOTH sets — `harness
    // reliability` resolves a scenario by id against these fixtures, so a set
    // that is not rendered here cannot be run at all. Counted from the sets
    // themselves rather than pinned to a literal: adding a scenario must not
    // require editing a number here to keep the meeting set covered.
    const spoken = [...DERAIL_SCENARIOS, ...MEETING_SCENARIOS].filter((s) => s.calleeLine);
    expect(written).toHaveLength(spoken.length);
    expect(written.every((p) => p.endsWith(".pcm"))).toBe(true);
    expect(written.some((p) => p.includes("silence"))).toBe(false);
    expect(written.some((p) => p.includes("hold-music"))).toBe(false);
    // The meeting set is actually in there, not merely counted.
    expect(written).toContain("/out/consent-refused.pcm");
    // 2400 samples @24k → 1600 samples @16k → 3200 bytes.
    const first = writes[written[0]];
    expect(first.length).toBe(3200);
    expect(synth).toHaveBeenCalledTimes(spoken.length);
  });
});

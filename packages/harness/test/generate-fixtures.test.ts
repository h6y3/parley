import { describe, expect, it, vi } from "vitest";
import { generateFixtures } from "../src/generate-fixtures.js";
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

    // 8 scenarios, one is silence → 7 files.
    expect(written).toHaveLength(7);
    expect(written.every((p) => p.endsWith(".pcm"))).toBe(true);
    expect(written.some((p) => p.includes("silence"))).toBe(false);
    // 2400 samples @24k → 1600 samples @16k → 3200 bytes.
    const first = writes[written[0]];
    expect(first.length).toBe(3200);
    expect(synth).toHaveBeenCalledTimes(7);
  });
});

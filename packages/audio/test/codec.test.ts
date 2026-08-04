import { describe, expect, it } from "vitest";
import type { AudioFrame } from "@parley/core";
import { createAudioCodec } from "../src/codec.js";
import { muLawEncode } from "../src/mulaw.js";
import { samplesToPcm16Buffer } from "../src/pcm.js";

describe("createAudioCodec", () => {
  const codec = createAudioCodec();

  it("decodeInbound: mulaw8k → pcm16k with doubled sample count", () => {
    const mulaw: AudioFrame = { encoding: "mulaw8k", data: muLawEncode(new Int16Array(160).fill(2000)) };
    const out = codec.decodeInbound(mulaw);
    expect(out.encoding).toBe("pcm16k");
    expect(out.data.length).toBe(320 * 2); // 320 samples, 2 bytes each
  });

  it("encodeOutbound: pcm24k → mulaw8k with a third the sample count", () => {
    const pcm24k: AudioFrame = { encoding: "pcm24k", data: samplesToPcm16Buffer(new Int16Array(480).fill(2000)) };
    const out = codec.encodeOutbound(pcm24k);
    expect(out.encoding).toBe("mulaw8k");
    expect(out.data.length).toBe(160); // 160 μ-law bytes
  });
});

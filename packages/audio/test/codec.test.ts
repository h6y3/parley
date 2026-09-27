import { describe, expect, it } from "vitest";
import { MULAW_8K, PCM_16K, PCM_24K, type AudioFrame } from "@parley/core";
import { createAudioCodec } from "../src/codec.js";
import { muLawEncode } from "../src/mulaw.js";
import { samplesToPcm16Buffer } from "../src/pcm.js";

describe("createAudioCodec", () => {
  const codec = createAudioCodec();

  it("decodeInbound: mulaw@8000 → pcm@16000 with doubled sample count", () => {
    const mulaw: AudioFrame = {
      encoding: MULAW_8K,
      data: muLawEncode(new Int16Array(160).fill(2000))
    };
    const out = codec.decodeInbound(mulaw);
    expect(out.encoding).toEqual(PCM_16K);
    expect(out.data.length).toBe(320 * 2); // 320 samples, 2 bytes each
  });

  it("encodeOutbound: pcm@24000 → mulaw@8000 with a third the sample count", () => {
    const pcm24k: AudioFrame = {
      encoding: PCM_24K,
      data: samplesToPcm16Buffer(new Int16Array(480).fill(2000))
    };
    const out = codec.encodeOutbound(pcm24k);
    expect(out.encoding).toEqual(MULAW_8K);
    expect(out.data.length).toBe(160); // 160 μ-law bytes
  });
});

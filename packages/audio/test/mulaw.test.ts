import { describe, expect, it } from "vitest";
import { muLawDecode, muLawDecodeSample, muLawEncode, muLawEncodeSample } from "../src/mulaw.js";

describe("G.711 μ-law codec", () => {
  it("encodes silence (0) to 0xFF (standard anchor)", () => {
    expect(muLawEncodeSample(0)).toBe(0xff);
  });

  it("round-trips within μ-law quantization tolerance and preserves sign", () => {
    for (const x of [-32000, -8000, -1500, -100, 100, 1500, 8000, 32000]) {
      const y = muLawDecodeSample(muLawEncodeSample(x));
      expect(Math.sign(y)).toBe(Math.sign(x));
      expect(Math.abs(y - x)).toBeLessThanOrEqual(Math.abs(x) * 0.15 + 200);
    }
  });

  it("clips magnitudes beyond the μ-law clip point without overflow", () => {
    expect(Math.sign(muLawDecodeSample(muLawEncodeSample(40000)))).toBe(1);
    expect(Math.sign(muLawDecodeSample(muLawEncodeSample(-40000)))).toBe(-1);
  });

  it("encodes/decodes whole buffers element-wise", () => {
    const samples = Int16Array.from([0, 1000, -1000, 16000]);
    const encoded = muLawEncode(samples);
    expect(encoded).toHaveLength(4);
    const decoded = muLawDecode(encoded);
    expect(decoded).toHaveLength(4);
    expect(Math.sign(decoded[3])).toBe(1);
  });
});

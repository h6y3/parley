import { describe, expect, it } from "vitest";
import {
  PACKAGE_NAME,
  muLawDecode,
  muLawDecodeSample,
  muLawEncode,
  muLawEncodeSample,
  pcm16BufferToSamples,
  samplesToPcm16Buffer
} from "../src/index.js";

describe("@parley/audio scaffold", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@parley/audio");
  });

  it("exports μ-law codec functions", () => {
    expect(muLawEncodeSample).toBeDefined();
    expect(muLawDecodeSample).toBeDefined();
    expect(muLawEncode).toBeDefined();
    expect(muLawDecode).toBeDefined();
  });

  it("exports PCM16 buffer helpers", () => {
    expect(pcm16BufferToSamples).toBeDefined();
    expect(samplesToPcm16Buffer).toBeDefined();
  });
});

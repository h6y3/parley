import { describe, expect, it } from "vitest";
import { pcm16BufferToSamples, samplesToPcm16Buffer } from "../src/pcm.js";

describe("PCM16 buffer helpers", () => {
  it("round-trips samples ↔ little-endian bytes", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 12345]);
    const buf = samplesToPcm16Buffer(samples);
    expect(buf.length).toBe(samples.length * 2);
    expect(Array.from(pcm16BufferToSamples(buf))).toEqual(Array.from(samples));
  });

  it("writes little-endian byte order", () => {
    const buf = samplesToPcm16Buffer(Int16Array.from([0x0102]));
    expect(buf[0]).toBe(0x02);
    expect(buf[1]).toBe(0x01);
  });

  it("truncates a trailing odd byte", () => {
    const odd = Buffer.from([0x10, 0x00, 0x7f]); // 1.5 samples' worth of bytes
    expect(pcm16BufferToSamples(odd)).toHaveLength(1);
    expect(pcm16BufferToSamples(odd)[0]).toBe(0x0010);
  });
});

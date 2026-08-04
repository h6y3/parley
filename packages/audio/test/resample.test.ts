import { describe, expect, it } from "vitest";
import { decimateBy3, resampleLinear } from "../src/resample.js";

describe("resampleLinear", () => {
  it("returns a copy at equal rates", () => {
    const input = Int16Array.from([1, 2, 3]);
    const out = resampleLinear(input, 8000, 8000);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(out).not.toBe(input);
  });

  it("upsamples 8k→16k to ~double length and preserves a DC level", () => {
    const input = new Int16Array(160).fill(5000);
    const out = resampleLinear(input, 8000, 16000);
    expect(out.length).toBe(320);
    expect(out[0]).toBe(5000);
    expect(out[out.length - 1]).toBe(5000);
    expect(out[100]).toBe(5000);
  });

  it("linearly interpolates a ramp on ×2 upsample", () => {
    const out = resampleLinear(Int16Array.from([0, 100]), 8000, 16000);
    expect(out.length).toBe(4);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(100);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(out[2]);
  });
});

describe("decimateBy3 (24k→8k averaging)", () => {
  it("produces one third the samples and preserves DC", () => {
    const input = new Int16Array(480).fill(3000);
    const out = decimateBy3(input);
    expect(out.length).toBe(160);
    expect(out[0]).toBe(3000);
    expect(out[159]).toBe(3000);
  });

  it("averages each group of three input samples", () => {
    const out = decimateBy3(Int16Array.from([0, 30, 60, 300, 300, 300]));
    expect(out[0]).toBe(30);
    expect(out[1]).toBe(300);
  });

  it("attenuates a full-scale alternating (near-Nyquist) signal below its peak", () => {
    const input = Int16Array.from({ length: 480 }, (_v, i) => (i % 2 === 0 ? 10000 : -10000));
    const out = decimateBy3(input);
    expect(Math.max(...Array.from(out).map(Math.abs))).toBeLessThan(10000);
  });
});

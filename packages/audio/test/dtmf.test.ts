import { describe, expect, it } from "vitest";
import { muLawDecode } from "../src/mulaw.js";
import { DTMF_FREQUENCIES, dtmfMuLaw } from "../src/dtmf.js";

const RATE = 8000;

/** Goertzel: energy at one frequency in a sample window. Cheaper and clearer
 * than an FFT for "is this tone present", and it is what a real DTMF detector
 * uses — so the test decides by the same method the far end will. */
function goertzel(samples: Int16Array, freq: number): number {
  const k = Math.round((samples.length * freq) / RATE);
  const w = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const sample of samples) {
    const s0 = sample / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function samplesOf(frame: { data: Buffer }): Int16Array {
  return muLawDecode(frame.data);
}

describe("dtmfMuLaw", () => {
  it("emits 8kHz mu-law, the encoding the carrier stream speaks", () => {
    expect(dtmfMuLaw("1").encoding).toBe("mulaw8k");
  });

  it("carries both tones of the digit and neither of another", () => {
    // The whole point: a DTMF digit IS its two frequencies. Asserting on byte
    // length would pass for silence.
    const s = samplesOf(dtmfMuLaw("5", { toneMs: 200, gapMs: 0 }));
    const [low, high] = DTMF_FREQUENCIES["5"];
    const present = Math.min(goertzel(s, low), goertzel(s, high));
    const absent = Math.max(
      goertzel(s, DTMF_FREQUENCIES["1"][0]),
      goertzel(s, DTMF_FREQUENCIES["3"][1])
    );
    expect(present).toBeGreaterThan(absent * 5);
  });

  it("covers every key a keypad has, including * and #", () => {
    for (const digit of Object.keys(DTMF_FREQUENCIES)) {
      const s = samplesOf(dtmfMuLaw(digit, { toneMs: 120, gapMs: 0 }));
      const [low, high] = DTMF_FREQUENCIES[digit];
      expect(Math.min(goertzel(s, low), goertzel(s, high))).toBeGreaterThan(1);
    }
  });

  it("separates multiple digits with silence, or the far end hears one long tone", () => {
    const frame = dtmfMuLaw("11", { toneMs: 100, gapMs: 100 });
    const s = samplesOf(frame);
    // 100ms tone + 100ms gap + 100ms tone + 100ms gap = 400ms at 8kHz.
    expect(s.length).toBe(0.4 * RATE);
    const gap = s.slice(Math.round(0.11 * RATE), Math.round(0.19 * RATE));
    const peak = Math.max(...Array.from(gap, (v) => Math.abs(v)));
    expect(peak).toBeLessThan(2000);
  });

  it("does not clip when the two tones add", () => {
    const s = samplesOf(dtmfMuLaw("9", { toneMs: 150, gapMs: 0 }));
    expect(Math.max(...Array.from(s, (v) => Math.abs(v)))).toBeLessThan(32000);
  });

  it("rejects a key that is not on a telephone", () => {
    expect(() => dtmfMuLaw("1x")).toThrow(/x/);
  });
});

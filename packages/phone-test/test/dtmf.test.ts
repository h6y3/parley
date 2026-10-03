import { describe, expect, it } from "vitest";
import { DTMF_FREQUENCIES, dtmfMuLaw, muLawEncode } from "@parley/audio";
import { DtmfDetector } from "../src/dtmf.js";

const RATE = 8000;
const FRAME = 160; // Twilio sends 20 ms μ-law frames
const samples = (ms: number): number => Math.round((ms * RATE) / 1000);

/** Deterministic PRNG (mulberry32), so the noise fixtures never flake. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Feeds `mulaw` to a fresh detector in 20 ms frames and returns every digit. */
function detect(mulaw: Buffer, detector = new DtmfDetector()): string[] {
  const out: string[] = [];
  for (let i = 0; i < mulaw.length; i += FRAME) {
    out.push(...detector.push(mulaw.subarray(i, i + FRAME)));
  }
  return out;
}

/** A sum of sines; `tones` are [frequency Hz, amplitude as a fraction of full scale]. */
function sines(ms: number, tones: [number, number][]): Int16Array {
  const n = samples(ms);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const [f, a] of tones) v += a * Math.sin((2 * Math.PI * f * i) / RATE);
    pcm[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  }
  return pcm;
}

const silence = (ms: number): Int16Array => new Int16Array(samples(ms));

function concat(...parts: Int16Array[]): Buffer {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const pcm = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    pcm.set(p, at);
    at += p.length;
  }
  return muLawEncode(pcm);
}

const press = (digit: string, ms: number, amp = 0.35): Int16Array => {
  const [low, high] = DTMF_FREQUENCIES[digit]!;
  return sines(ms, [
    [low, amp],
    [high, amp]
  ]);
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

describe("DtmfDetector", () => {
  it.each(KEYS)("detects %s, as Parley sends it, exactly once", (key) => {
    const tone = dtmfMuLaw(key).data;
    expect(detect(Buffer.concat([concat(silence(200)), tone, concat(silence(300))]))).toEqual([
      key
    ]);
  });

  it("detects a whole keyed sequence in order", () => {
    expect(detect(dtmfMuLaw("0123456789*#").data)).toEqual([..."0123456789*#"]);
  });

  it("detects a press however the frames are split", () => {
    const tone = Buffer.concat([concat(silence(37)), dtmfMuLaw("5").data, concat(silence(100))]);
    const d = new DtmfDetector();
    const out: string[] = [];
    for (let i = 0; i < tone.length; i += 97) out.push(...d.push(tone.subarray(i, i + 97)));
    expect(out).toEqual(["5"]);
  });

  it("detects a quieter, twisted press within limits", () => {
    const [low, high] = DTMF_FREQUENCIES["8"]!;
    const pcm = sines(120, [
      [low, 0.05],
      [high, 0.1] // 6 dB twist
    ]);
    expect(detect(concat(silence(100), pcm, silence(100)))).toEqual(["8"]);
  });

  it("reads two presses of the same digit 100 ms apart as two digits", () => {
    expect(detect(concat(press("7", 120), silence(100), press("7", 120), silence(100)))).toEqual([
      "7",
      "7"
    ]);
    expect(detect(dtmfMuLaw("22", { gapMs: 100 }).data)).toEqual(["2", "2"]);
  });

  it("reads one long press as one digit", () => {
    expect(detect(concat(press("4", 1500), silence(100)))).toEqual(["4"]);
  });

  it("detects a 40 ms press and ignores a 30 ms one", () => {
    expect(detect(concat(silence(100), press("3", 40), silence(200)))).toEqual(["3"]);
    expect(detect(concat(silence(100), press("3", 30), silence(200)))).toEqual([]);
    expect(detect(dtmfMuLaw("1593", { toneMs: 40, gapMs: 100 }).data)).toEqual([..."1593"]);
  });

  it("separates presses 40 ms apart and bridges a 20 ms dropout inside one", () => {
    expect(detect(dtmfMuLaw("1111", { toneMs: 100, gapMs: 40 }).data)).toEqual([..."1111"]);
    expect(detect(concat(press("6", 100), silence(20), press("6", 100), silence(100)))).toEqual([
      "6"
    ]);
  });

  it("ignores single tones, row or column", () => {
    for (const f of [697, 770, 852, 941, 1209, 1336, 1477, 1633]) {
      expect(detect(concat(sines(300, [[f, 0.5]]), silence(100)))).toEqual([]);
    }
  });

  it("ignores a pair whose twist is past 8 dB", () => {
    const [low, high] = DTMF_FREQUENCIES["5"]!;
    const pcm = sines(300, [
      [low, 0.4],
      [high, 0.4 / 4] // 12 dB down
    ]);
    expect(detect(concat(pcm, silence(100)))).toEqual([]);
  });

  it("ignores a pair with a third DTMF tone as loud as the others", () => {
    const pcm = sines(300, [
      [697, 0.25],
      [770, 0.25],
      [1336, 0.25]
    ]);
    expect(detect(concat(pcm, silence(100)))).toEqual([]);
  });

  it("ignores a pair below the absolute level threshold", () => {
    expect(detect(concat(press("9", 300, 0.004), silence(100)))).toEqual([]);
  });

  it("ignores the A–D column: not a telephone key a menu offers", () => {
    expect(detect(dtmfMuLaw("ABCD").data)).toEqual([]);
  });

  it("ignores silence and white noise", () => {
    expect(detect(concat(silence(2000)))).toEqual([]);
    const r = rng(7);
    const noise = new Int16Array(samples(3000));
    for (let i = 0; i < noise.length; i++) noise[i] = Math.round((r() * 2 - 1) * 12000);
    expect(detect(muLawEncode(noise))).toEqual([]);
  });

  it("ignores speech-like audio: a gliding voiced fundamental with formants", () => {
    const r = rng(11);
    const n = samples(4000);
    const pcm = new Int16Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      // A pitch that glides like intonation, 100–220 Hz.
      const f0 = 160 + 60 * Math.sin(2 * Math.PI * 0.7 * t) + 20 * Math.sin(2 * Math.PI * 3.1 * t);
      phase += (2 * Math.PI * f0) / RATE;
      // Harmonics shaped by two moving formants (vowel-like).
      const f1 = 600 + 250 * Math.sin(2 * Math.PI * 1.3 * t);
      const f2 = 1400 + 500 * Math.sin(2 * Math.PI * 0.9 * t);
      let v = 0;
      for (let h = 1; h * f0 < 3800; h++) {
        const fh = h * f0;
        const g =
          Math.exp(-(((fh - f1) / 150) ** 2)) + 0.6 * Math.exp(-(((fh - f2) / 200) ** 2)) + 0.05;
        v += g * Math.sin(h * phase);
      }
      // Syllable envelope at ~4 Hz, and a little breath noise.
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
      pcm[i] = Math.round(Math.max(-1, Math.min(1, 0.12 * env * v + 0.01 * (r() * 2 - 1))) * 32767);
    }
    expect(detect(muLawEncode(pcm))).toEqual([]);
  });
});

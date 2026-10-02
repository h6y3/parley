import { describe, expect, it } from "vitest";
import { muLawEncode } from "@parley/audio";
import { CaptureRecorder, splitStereo } from "../src/capture.js";

const tone = (): Buffer => muLawEncode(new Int16Array(160).fill(8000));
const silence = (): Buffer => Buffer.alloc(160, 0xff);

function samples(wav: Buffer, ch: number, channels: number): Int16Array {
  const n = (wav.length - 44) / 2 / channels;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = wav.readInt16LE(44 + (i * channels + ch) * 2);
  return out;
}
const firstNonZero = (s: Int16Array): number => s.findIndex((v) => v !== 0);

function record() {
  let t = 5000;
  const rec = new CaptureRecorder(() => t);
  rec.agent(tone());
  t = 5020;
  rec.agent(tone());
  t = 6000;
  rec.callee(tone());
  rec.mark("callee-hangup");
  rec.calleeSaid("hello");
  rec.calleeSaid("bye");
  return rec.finish();
}

describe("CaptureRecorder", () => {
  it("writes a stereo 8 kHz WAV with correct header", () => {
    const { wav } = record();
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(32)).toBe(4);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });

  it("places frames by arrival time on a shared clock", () => {
    const { wav } = record();
    expect(firstNonZero(samples(wav, 0, 2))).toBe(0);
    expect(Math.abs(firstNonZero(samples(wav, 1, 2)) - 8000)).toBeLessThanOrEqual(160);
    expect(samples(wav, 0, 2).length).toBe(samples(wav, 1, 2).length);
  });

  it("records marks, callee text and is JSON-serialisable", () => {
    const { timeline } = record();
    expect(timeline.startedAtMs).toBe(5000);
    expect(timeline.sampleRate).toBe(8000);
    expect(timeline.channels).toEqual({ agent: "L", callee: "R" });
    expect(timeline.events).toEqual([{ atMs: 1000, event: "callee-hangup" }]);
    expect(timeline.calleeText).toEqual(["hello", "bye"]);
    expect(JSON.parse(JSON.stringify(timeline))).toEqual(timeline);
  });

  it("queues overlapping frames rather than overwriting", () => {
    const rec = new CaptureRecorder(() => 0);
    rec.agent(tone());
    rec.agent(silence());
    const { wav } = rec.finish();
    expect(samples(wav, 0, 2).length).toBe(320);
  });

  it("handles an empty recording", () => {
    const { wav } = new CaptureRecorder(() => 0).finish();
    expect(wav.length).toBe(44);
  });
});

describe("CaptureRecorder.clearCallee", () => {
  it("drops callee audio queued beyond the current clock, keeping what already played", () => {
    let t = 0;
    const rec = new CaptureRecorder(() => t);
    // A 60 ms burst at t=0: samples 0..480, of which only 0..160 has played by t=20.
    rec.callee(tone());
    rec.callee(tone());
    rec.callee(tone());
    t = 20;
    rec.clearCallee();
    rec.agent(tone()); // at sample 160
    const r = samples(rec.finish().wav, 1, 2);
    expect(r.length).toBe(320);
    expect(r.subarray(0, 160).every((v) => v !== 0)).toBe(true);
    expect(r.subarray(160).every((v) => v === 0)).toBe(true);
  });

  it("places the next callee frame at the clock, not after the dropped audio", () => {
    let t = 0;
    const rec = new CaptureRecorder(() => t);
    rec.callee(tone());
    rec.callee(tone());
    rec.callee(tone());
    t = 20;
    rec.clearCallee();
    rec.callee(tone());
    const r = samples(rec.finish().wav, 1, 2);
    expect(r.length).toBe(320);
    expect(r.every((v) => v !== 0)).toBe(true);
  });

  it("is a no-op when nothing is queued ahead of the clock", () => {
    let t = 0;
    const rec = new CaptureRecorder(() => t);
    rec.callee(tone());
    t = 100;
    rec.clearCallee();
    rec.clearCallee();
    t = 100;
    rec.callee(tone()); // at sample 800
    const r = samples(rec.finish().wav, 1, 2);
    expect(r.length).toBe(960);
    expect(firstNonZero(r.subarray(160))).toBe(640);
  });
});

describe("splitStereo", () => {
  it("round-trips channels into mono WAVs", () => {
    const { wav } = record();
    const { agent, callee } = splitStereo(wav);
    for (const m of [agent, callee]) {
      expect(m.readUInt16LE(22)).toBe(1);
      expect(m.readUInt32LE(24)).toBe(8000);
      expect(m.readUInt32LE(28)).toBe(16000);
      expect(m.readUInt16LE(32)).toBe(2);
      expect(m.readUInt16LE(34)).toBe(16);
      expect(m.readUInt32LE(40)).toBe(m.length - 44);
    }
    expect(Array.from(samples(agent, 0, 1))).toEqual(Array.from(samples(wav, 0, 2)));
    expect(Array.from(samples(callee, 0, 1))).toEqual(Array.from(samples(wav, 1, 2)));
  });
});

import { describe, expect, it } from "vitest";
import { MULAW_8K, PCM_16K, PCM_24K } from "@parley/core";
import { canConvert, convert } from "../src/convert.js";

describe("convert", () => {
  it("returns the SAME frame object when the encoding already matches", () => {
    const frame = { encoding: MULAW_8K, data: Buffer.from([0x7f, 0x7f]) };
    expect(convert(frame, MULAW_8K)).toBe(frame);
  });

  it("decodes mulaw@8000 up to pcm@16000 with two samples out per sample in", () => {
    const frame = { encoding: MULAW_8K, data: Buffer.alloc(160, 0xff) };
    const out = convert(frame, PCM_16K);
    expect(out.encoding).toEqual(PCM_16K);
    expect(out.data.length).toBe(160 * 2 * 2);
  });

  it("decimates pcm@24000 down to mulaw@8000 at one byte per three samples", () => {
    const frame = { encoding: PCM_24K, data: Buffer.alloc(480 * 2) };
    const out = convert(frame, MULAW_8K);
    expect(out.encoding).toEqual(MULAW_8K);
    expect(out.data.length).toBe(160);
  });

  it("refuses a conversion it has no path for, naming both encodings", () => {
    const frame = { encoding: PCM_16K, data: Buffer.alloc(2) };
    expect(() => convert(frame, { codec: "mulaw", sampleRate: 16000 })).toThrow(
      /pcm@16000.*mulaw@16000/
    );
  });
});

describe("canConvert", () => {
  it("is true for identity on every encoding Parley speaks", () => {
    for (const e of [MULAW_8K, PCM_16K, PCM_24K]) expect(canConvert(e, e)).toBe(true);
  });

  it("is true for exactly the three paths convert implements", () => {
    expect(canConvert(MULAW_8K, PCM_16K)).toBe(true);
    expect(canConvert(PCM_24K, MULAW_8K)).toBe(true);
    expect(canConvert(PCM_16K, MULAW_8K)).toBe(true);
  });

  it("is false where no path exists", () => {
    expect(canConvert(MULAW_8K, PCM_24K)).toBe(false);
    expect(canConvert(PCM_24K, PCM_16K)).toBe(false);
  });

  it("agrees with convert: it throws exactly where canConvert is false", () => {
    const all = [MULAW_8K, PCM_16K, PCM_24K];
    for (const from of all) {
      for (const to of all) {
        // 160 samples: an even byte count for pcm, one carrier frame for mulaw.
        const frame = { encoding: from, data: Buffer.alloc(from.codec === "pcm" ? 320 : 160) };
        if (canConvert(from, to)) expect(() => convert(frame, to)).not.toThrow();
        else expect(() => convert(frame, to)).toThrow(/no conversion path/);
      }
    }
  });
});

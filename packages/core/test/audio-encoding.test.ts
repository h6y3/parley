import { describe, expect, it } from "vitest";
import { encodingEquals, formatEncoding, MULAW_8K, PCM_16K, PCM_24K } from "../src/index.js";

describe("AudioEncoding", () => {
  it("names the three encodings Parley already speaks", () => {
    expect(MULAW_8K).toEqual({ codec: "mulaw", sampleRate: 8000 });
    expect(PCM_16K).toEqual({ codec: "pcm", sampleRate: 16000 });
    expect(PCM_24K).toEqual({ codec: "pcm", sampleRate: 24000 });
  });

  it("compares by value, not identity", () => {
    expect(encodingEquals({ codec: "pcm", sampleRate: 16000 }, PCM_16K)).toBe(true);
    expect(encodingEquals(PCM_16K, PCM_24K)).toBe(false);
  });

  it("formats for error messages without leaking a Buffer", () => {
    expect(formatEncoding(MULAW_8K)).toBe("mulaw@8000");
  });
});

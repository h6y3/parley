import { describe, expect, it } from "vitest";
import { AudioBridge } from "../src/audio-bridge.js";
import { MULAW_8K, PCM_16K } from "../src/index.js";

const identity = (frame: { encoding: unknown; data: Buffer }) => frame;

describe("AudioBridge", () => {
  it("passes through when the sink already accepts the source encoding, and COUNTS it", () => {
    const bridge = new AudioBridge([MULAW_8K], identity as never);
    const frame = { encoding: MULAW_8K, data: Buffer.from([1]) };
    expect(bridge.adapt(frame)).toBe(frame);
    expect(bridge.passThroughs).toBe(1);
    expect(bridge.conversions).toBe(0);
  });

  it("converts when the sets do not intersect, and COUNTS that", () => {
    const called: string[] = [];
    const bridge = new AudioBridge([PCM_16K], ((f: never, to: never) => {
      called.push("converted");
      return { encoding: to, data: (f as { data: Buffer }).data };
    }) as never);
    bridge.adapt({ encoding: MULAW_8K, data: Buffer.from([1]) });
    expect(called).toEqual(["converted"]);
    expect(bridge.conversions).toBe(1);
  });

  it("throws when the sink accepts nothing", () => {
    expect(() => new AudioBridge([], identity as never)).toThrow(/at least one encoding/);
  });
});

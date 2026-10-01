import { describe, expect, it, vi } from "vitest";
// The REAL converter, reached by path rather than as a dependency: @parley/audio
// depends on @parley/core, so core cannot declare it back. The point of this
// file is that the contract holds against the conversion table that ships —
// a relabelling fake would pass whatever the bridge asked of it.
import { canConvert, convert } from "../../audio/src/convert.js";
import { AudioContractError, CallSession } from "../src/call-session.js";
import type { CallSessionParams } from "../src/call-session.js";
import { MULAW_8K, PCM_16K, PCM_24K } from "../src/types.js";
import type {
  AudioEncoding,
  AudioFrame,
  RealtimeAudioFormat,
  TelephonyProvider
} from "../src/types.js";
import { brief, guardrails, fakeCodec, fakes, FakeSocket } from "./helpers/call-session-harness.js";

const DEEPGRAM_SHAPE: RealtimeAudioFormat = { accepts: [MULAW_8K], emits: MULAW_8K };
const GEMINI_SHAPE: RealtimeAudioFormat = { accepts: [PCM_16K], emits: PCM_24K };
const PCM_48K: AudioEncoding = { codec: "pcm", sampleRate: 48000 };

/** 20 ms of carrier audio: 160 mu-law bytes. */
function carrierFrame(fill: number): AudioFrame {
  return { encoding: MULAW_8K, data: Buffer.alloc(160, fill) };
}

/** 20 ms of 24 kHz PCM: 480 samples, 960 bytes. */
function pcm24kFrame(): AudioFrame {
  return { encoding: PCM_24K, data: Buffer.alloc(960) };
}

function build(audio: RealtimeAudioFormat, execution?: CallSessionParams["execution"]) {
  const f = fakes();
  const originate = vi.fn(f.telephony.originate);
  const telephony: TelephonyProvider = { ...f.telephony, mediaEncoding: MULAW_8K, originate };
  const cs = new CallSession({
    brief,
    guardrails,
    telephony,
    realtime: { ...f.realtime, audio },
    codec: fakeCodec,
    convert,
    canConvert,
    from: "+15555550142",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "test-model",
    ...(execution ? { execution } : {})
  });
  return { f, cs, originate };
}

describe("audio contract: a provider speaking the carrier's encoding", () => {
  it("passes inbound carrier frames to sendAudio unchanged, with zero conversions", async () => {
    const { f, cs } = build(DEEPGRAM_SHAPE);
    await cs.attach("CA1", new FakeSocket());
    const frames = [carrierFrame(1), carrierFrame(2), carrierFrame(3)];
    for (const frame of frames) f.emitInbound(frame);

    expect(f.sentAudio).toHaveLength(3);
    frames.forEach((frame, i) => expect(f.sentAudio[i]).toBe(frame));
    expect(cs.audioBridgeStats.inbound).toEqual({ conversions: 0, passThroughs: 3 });
  });

  it("passes model frames to the carrier unchanged, with zero conversions", async () => {
    const { f, cs } = build(DEEPGRAM_SHAPE);
    await cs.attach("CA1", new FakeSocket());
    const frames = [carrierFrame(4), carrierFrame(5)];
    for (const frame of frames) f.emitModelAudio(frame);

    expect(f.sentOutbound).toHaveLength(2);
    frames.forEach((frame, i) => expect(f.sentOutbound[i]).toBe(frame));
    expect(cs.audioBridgeStats.outbound).toEqual({ conversions: 0, passThroughs: 2 });
  });
});

describe("audio contract: a provider speaking PCM", () => {
  it("converts inbound carrier frames to pcm@16000 before sendAudio", async () => {
    const { f, cs } = build(GEMINI_SHAPE);
    await cs.attach("CA1", new FakeSocket());
    f.emitInbound(carrierFrame(0xff));
    f.emitInbound(carrierFrame(0xff));

    expect(f.sentAudio.map((a) => a.encoding)).toEqual([PCM_16K, PCM_16K]);
    // 160 samples at 8 kHz → 320 at 16 kHz → 640 bytes.
    expect(f.sentAudio.map((a) => a.data.length)).toEqual([640, 640]);
    expect(cs.audioBridgeStats.inbound).toEqual({ conversions: 2, passThroughs: 0 });
  });

  it("converts model pcm@24000 to the carrier's mulaw@8000", async () => {
    const { f, cs } = build(GEMINI_SHAPE);
    await cs.attach("CA1", new FakeSocket());
    f.emitModelAudio(pcm24kFrame());
    f.emitModelAudio(pcm24kFrame());

    expect(f.sentOutbound.map((a) => a.encoding)).toEqual([MULAW_8K, MULAW_8K]);
    expect(f.sentOutbound.map((a) => a.data.length)).toEqual([160, 160]);
    expect(cs.audioBridgeStats.outbound).toEqual({ conversions: 2, passThroughs: 0 });
  });
});

describe("assertAudioContract", () => {
  it("accepts both shipped declarations against a mu-law carrier", () => {
    expect(() => build(DEEPGRAM_SHAPE).cs.assertAudioContract()).not.toThrow();
    expect(() => build(GEMINI_SHAPE).cs.assertAudioContract()).not.toThrow();
  });

  it("refuses a provider whose output the carrier cannot be reached from", () => {
    const { cs } = build({ accepts: [PCM_16K], emits: PCM_48K });
    let caught: unknown;
    try {
      cs.assertAudioContract();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AudioContractError);
    expect(caught).toMatchObject({
      reason: "no_conversion_path",
      from: "pcm@48000",
      to: "mulaw@8000"
    });
  });

  it("refuses a provider whose input the carrier cannot reach", () => {
    const { cs } = build({ accepts: [PCM_48K], emits: MULAW_8K });
    expect(() => cs.assertAudioContract()).toThrow(AudioContractError);
    try {
      cs.assertAudioContract();
    } catch (err) {
      expect(err).toMatchObject({ from: "mulaw@8000", to: "pcm@48000" });
    }
  });

  it("refuses a provider that declares no accepted encoding at all", () => {
    const { cs } = build({ accepts: [], emits: MULAW_8K });
    expect(() => cs.assertAudioContract()).toThrow(AudioContractError);
  });

  it("originate() refuses an impossible pairing before the carrier is asked to dial", async () => {
    const { cs, originate } = build({ accepts: [PCM_16K], emits: PCM_48K });
    await expect(cs.originate()).rejects.toBeInstanceOf(AudioContractError);
    expect(originate).not.toHaveBeenCalled();
  });

  it("originate() dials a possible pairing", async () => {
    const { cs, originate } = build(DEEPGRAM_SHAPE);
    await cs.originate();
    expect(originate).toHaveBeenCalledTimes(1);
  });
});

describe("audio contract: DTMF", () => {
  it("a press sends the codec's tones to the carrier untouched, outside the outbound bridge", async () => {
    const { f, cs } = build(GEMINI_SHAPE, {
      ivr: { maxPresses: 3, allowedDigits: "0123456789", onUnrecognized: "zeroOut" }
    });
    await cs.attach("CA1", new FakeSocket());
    await f.emitToolCall({ id: "c1", name: "press_digits", args: { digits: "42" } });

    expect(f.sentOutbound).toHaveLength(1);
    expect(f.sentOutbound[0]).toEqual(fakeCodec.dtmfTones("42"));
    expect(cs.audioBridgeStats.outbound).toEqual({ conversions: 0, passThroughs: 0 });
  });
});

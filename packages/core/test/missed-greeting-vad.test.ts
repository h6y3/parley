import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession, MISSED_GREETING_NUDGE_MS } from "../src/call-session.js";
import type { CallSessionParams } from "../src/call-session.js";
import { CALL_ANSWERED_CUE } from "../src/render.js";
import type { OpeningDelivery, OpeningDeliveryByShape, RealtimeSession } from "../src/types.js";
import { MULAW_8K } from "../src/types.js";
import {
  brief,
  guardrails,
  fakeCanConvert,
  fakeCodec,
  fakeConvert,
  fakes,
  makeMeetingFakes,
  FakeSocket
} from "./helpers/call-session-harness.js";

/**
 * The missed-greeting nudge, armed from far-end VOICE rather than far-end
 * text. Live (phone-test smoke 3, Gemini): a callee greeting spoken ~0.2 s
 * after pickup arrived before the realtime session was ready, was never
 * transcribed, and the agent sat silent until the silence cap. CallSession now
 * runs a small energy VAD over the inbound carrier frames it already receives
 * — from the moment the media stream attaches, before connect — and treats a
 * far-end utterance's end as a transcript would be treated.
 */

const FRAME_MS = 20;

/** G.711 μ-law encode of one 16-bit linear sample. */
function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** 20 ms of μ-law at 8 kHz: a 300 Hz tone whose RMS is `dbfs`, or digital
 * silence when `dbfs` is undefined. */
function mulawFrame(dbfs?: number): { encoding: typeof MULAW_8K; data: Buffer } {
  const data = Buffer.alloc(160, 0xff);
  if (dbfs !== undefined) {
    const amplitude = 32768 * 10 ** (dbfs / 20) * Math.SQRT2;
    for (let i = 0; i < 160; i += 1) {
      data[i] = linearToMulaw(amplitude * Math.sin((2 * Math.PI * 300 * i) / 8000));
    }
  }
  return { encoding: MULAW_8K, data };
}

const VOICE_DBFS = -20;
const LINE_NOISE_DBFS = -50;

const modelFrame = () => ({ encoding: MULAW_8K, data: Buffer.alloc(160, 0xff) });

const nudges = (diagnostics: string[]) =>
  diagnostics.filter((d) => d.startsWith("missed greeting: opening re-sent at +"));
const voiceLines = (diagnostics: string[]) =>
  diagnostics.filter((d) => d.startsWith("missed greeting: far-end voice detected"));

/** Build a two-party call. With `deferConnect`, `attach` is left pending
 * inside the realtime connect — the media stream is up, the session is not —
 * until `connect()` is called. */
function twoPartyCall(
  opts: {
    openingDelivery?: OpeningDelivery | OpeningDeliveryByShape;
    execution?: CallSessionParams["execution"];
    deferConnect?: boolean;
  } = {}
) {
  const f = fakes();
  const diagnostics: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realtime = {
    ...f.realtime,
    openingDelivery: opts.openingDelivery ?? "prompt",
    connect: async (p: Parameters<typeof f.realtime.connect>[0]): Promise<RealtimeSession> => {
      if (opts.deferConnect) await gate;
      return f.realtime.connect(p);
    }
  };
  const cs = new CallSession({
    brief,
    guardrails,
    telephony: f.telephony,
    realtime,
    codec: fakeCodec,
    convert: fakeConvert,
    canConvert: fakeCanConvert,
    from: "+15555550142",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "test-model",
    ...(opts.execution ? { execution: opts.execution } : {}),
    onDiagnostic: (m) => diagnostics.push(m)
  });
  const attaching = cs.attach("call-1", new FakeSocket());
  /** Carrier audio in real time: each 20 ms frame arrives once its 20 ms
   * have passed. */
  const play = async (ms: number, dbfs?: number): Promise<void> => {
    for (let t = 0; t < ms; t += FRAME_MS) {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
      f.emitInbound(mulawFrame(dbfs));
    }
  };
  return {
    f,
    cs,
    diagnostics,
    attaching,
    play,
    connect: async () => {
      release();
      return attaching;
    }
  };
}

describe("missed-greeting nudge armed by far-end voice activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a 600 ms greeting at 0.2 s, never transcribed, model silent: cue at its end + 2500 ms, logged once", async () => {
    const { f, diagnostics, attaching, play } = twoPartyCall();
    await attaching;
    await play(200);
    await play(600, VOICE_DBFS);
    // The utterance ends after 300 ms of unvoiced audio.
    await play(300);
    expect(voiceLines(diagnostics)).toEqual(["missed greeting: far-end voice detected at +1100ms"]);
    await play(MISSED_GREETING_NUDGE_MS - FRAME_MS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(FRAME_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(nudges(diagnostics)).toEqual([
      `missed greeting: opening re-sent at +${1100 + MISSED_GREETING_NUDGE_MS}ms`
    ]);
    await play(5_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(voiceLines(diagnostics)).toHaveLength(1);
  });

  it("a greeting that arrives before the realtime session connects still counts", async () => {
    const { f, diagnostics, play, connect } = twoPartyCall({ deferConnect: true });
    await play(200);
    await play(600, VOICE_DBFS);
    await play(300);
    await play(400);
    // Connect lands at +1500 ms, 400 ms after the utterance ended.
    await connect();
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(MISSED_GREETING_NUDGE_MS - 400 - FRAME_MS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(FRAME_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(voiceLines(diagnostics)).toHaveLength(1);
  });

  it("a greeting still in progress when the session connects arms at its end", async () => {
    const { f, play, connect } = twoPartyCall({ deferConnect: true });
    await play(200);
    await play(400, VOICE_DBFS);
    await connect();
    await play(800, VOICE_DBFS);
    await play(300);
    await play(MISSED_GREETING_NUDGE_MS - FRAME_MS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(FRAME_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  /** The target case: a callee who says hello the instant they pick up.
   * Frame 0 is speech, so a floor learnt from the opening frames would be
   * the speech itself. */
  it("a greeting from the very first frame, then silence: the cue arms", async () => {
    const { f, diagnostics, attaching, play } = twoPartyCall();
    await attaching;
    await play(800, VOICE_DBFS);
    await play(300);
    expect(voiceLines(diagnostics)).toEqual(["missed greeting: far-end voice detected at +1100ms"]);
    await play(MISSED_GREETING_NUDGE_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  /** Sustained non-speech sound — a queue tone, a fax/CNG tone, loud steady
   * background — must never be learnt as the floor mid-sound: the utterance
   * would "end" while the sound goes on and the cue would go out into it. */
  it("a continuous −20 dBFS tone for 6 s: no cue", async () => {
    const { f, attaching, play } = twoPartyCall();
    await attaching;
    await play(200);
    await play(6_000, VOICE_DBFS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("~8 s of modulated hold-music-like energy: no cue", async () => {
    const { f, attaching } = twoPartyCall();
    await attaching;
    for (let t = 0; t < 8_000; t += FRAME_MS) {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
      // Level swings between −18 and −32 dBFS on a 4 s cycle.
      const dbfs = -25 + 7 * Math.sin((2 * Math.PI * t) / 4_000);
      f.emitInbound(mulawFrame(t < 200 ? undefined : dbfs));
    }
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("steady line noise at −50 dBFS for 10 s is not a voice: no cue", async () => {
    const { f, diagnostics, attaching, play } = twoPartyCall();
    await attaching;
    await play(10_000, LINE_NOISE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(voiceLines(diagnostics)).toEqual([]);
  });

  it("a burst shorter than 300 ms is a click, not an utterance: no cue", async () => {
    const { f, attaching, play } = twoPartyCall();
    await attaching;
    await play(200);
    await play(200, VOICE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a voiced burst that starts after 11 s is outside the opening window (R21): no cue", async () => {
    const { f, diagnostics, attaching, play } = twoPartyCall();
    await attaching;
    await play(11_000);
    await play(600, VOICE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(nudges(diagnostics)).toEqual([]);
  });

  it("model audio arriving before the timer fires: no cue", async () => {
    const { f, attaching, play } = twoPartyCall();
    await attaching;
    await play(200);
    await play(600, VOICE_DBFS);
    await play(300);
    await play(1_000);
    f.emitModelAudio(modelFrame());
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("far-end voice starting again holds the window until that utterance ends", async () => {
    const { f, attaching, play } = twoPartyCall();
    await attaching;
    await play(200);
    await play(400, VOICE_DBFS);
    await play(300);
    // Armed at +900 ms. Speech resumes 1 s later and runs 2 s.
    await play(1_000);
    await play(2_000, VOICE_DBFS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(300);
    await play(MISSED_GREETING_NUDGE_MS - FRAME_MS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(FRAME_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("far-end voice starting holds a window a transcript armed", async () => {
    const { f, attaching, play } = twoPartyCall();
    await attaching;
    f.emitTranscript({ speaker: "caller", text: "Hi.", isFinal: true });
    await play(500);
    await play(4_000, VOICE_DBFS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("an IVR-declared call (R20) is never nudged by voice", async () => {
    const { f, attaching, play } = twoPartyCall({
      execution: {
        ivr: { maxPresses: 4, allowedDigits: "0123456789", onUnrecognized: "waitForHuman" }
      }
    });
    await attaching;
    await play(200);
    await play(600, VOICE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a machine answer (R21) is never nudged by voice, even when the verdict lands before connect", async () => {
    const { f, play, connect } = twoPartyCall({ deferConnect: true });
    f.emitCallEvent({ type: "answered", answeredBy: "machine" });
    await play(200);
    await play(600, VOICE_DBFS);
    await play(300);
    await connect();
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a machine verdict while the voice-armed window is pending cancels it", async () => {
    const { f, attaching, play } = twoPartyCall();
    await attaching;
    await play(200);
    await play(600, VOICE_DBFS);
    await play(300);
    f.emitCallEvent({ type: "answered", answeredBy: "machine" });
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it('"turn" delivery: the opening went as a turn, voice sends nothing more', async () => {
    const { f, attaching, play } = twoPartyCall({ openingDelivery: "turn" });
    await attaching;
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    await play(200);
    await play(600, VOICE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("a meeting is never nudged by voice", async () => {
    const f = makeMeetingFakes();
    const diagnostics: string[] = [];
    const cs = new CallSession({
      ...f.params,
      realtime: { ...f.params.realtime, openingDelivery: "prompt" },
      onDiagnostic: (m) => diagnostics.push(m)
    });
    await cs.attach("CA1", new FakeSocket());
    const sentAtConnect = f.openingTrigger.mock.calls.length;
    for (let i = 0; i < 10; i += 1) f.emitInbound(mulawFrame());
    for (let i = 0; i < 30; i += 1) f.emitInbound(mulawFrame(VOICE_DBFS));
    for (let i = 0; i < 100; i += 1) f.emitInbound(mulawFrame());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(sentAtConnect);
    expect(f.openingTrigger).not.toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(voiceLines(diagnostics)).toEqual([]);
  });
});

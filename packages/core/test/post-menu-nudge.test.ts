import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallSession,
  MAX_GREETING_CUES_PER_CALL,
  POST_MENU_NUDGE_MS,
  POST_MENU_WINDOW_MS
} from "../src/call-session.js";
import type { CallSessionParams } from "../src/call-session.js";
import { CALL_ANSWERED_CUE } from "../src/render.js";
import { TONE_CONCENTRATION, ToneSpectrum } from "../src/voice-activity.js";
import type { OpeningDelivery, OpeningDeliveryByShape } from "../src/types.js";
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
 * The post-menu nudge. Live (0.5.1 phone test): on an IVR call the agent
 * pressed 2 correctly, a person then said "Scheduling, this is Sam." (Gemini
 * transcribed it as "Faire un SMS."), and the agent never replied — silent to
 * the silence cap. The opening nudge is off on an IVR-declared call (R20) and
 * a press is a tool call, which cancels it anyway. So on an IVR-declared call
 * each ACCEPTED press opens a POST_MENU_WINDOW_MS window; far-end speech that
 * starts inside it, followed by POST_MENU_NUDGE_MS of model silence, sends
 * `CALL_ANSWERED_CUE` once for that press.
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

type Frame = { encoding: typeof MULAW_8K; data: Buffer };

/** 20 ms of μ-law at 8 kHz from a linear-sample generator over absolute
 * sample time `n` (so tones stay phase-continuous across frames). */
function frameFrom(startSample: number, sample: (n: number) => number): Frame {
  const data = Buffer.alloc(160);
  for (let i = 0; i < 160; i += 1) data[i] = linearToMulaw(sample(startSample + i));
  return { encoding: MULAW_8K, data };
}

/** Digital silence. */
const silenceFrame = (): Frame => ({ encoding: MULAW_8K, data: Buffer.alloc(160, 0xff) });

/** Steady tones at `freqs` Hz, each at `dbfs` RMS. */
function toneFrame(startSample: number, freqs: number[], dbfs: number): Frame {
  const amplitude = 32768 * 10 ** (dbfs / 20) * Math.SQRT2;
  return frameFrom(startSample, (n) =>
    freqs.reduce((acc, f) => acc + amplitude * Math.sin((2 * Math.PI * f * n) / 8000), 0)
  );
}

/** Speech-like voiced audio: ten equal harmonics of a fundamental gliding
 * between 110 and 190 Hz, under a syllable-rate envelope, plus a little
 * deterministic noise — energy spread across many bins, unlike a tone. */
function speechFrame(startSample: number, dbfs: number): Frame {
  const amplitude = (32768 * 10 ** (dbfs / 20) * Math.SQRT2) / Math.sqrt(10);
  let seed = (startSample * 2654435761) >>> 0;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  return frameFrom(startSample, (n) => {
    const t = n / 8000;
    const f0 = 150 + 40 * Math.sin(2 * Math.PI * 1.7 * t);
    const envelope = 0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t);
    let v = 0;
    for (let h = 1; h <= 10; h += 1) v += Math.sin(2 * Math.PI * f0 * h * t + h);
    return envelope * amplitude * v + amplitude * 0.3 * noise();
  });
}

const VOICE_DBFS = -20;
/** US ringback: 440 + 480 Hz together. */
const RINGBACK_HZ = [440, 480];
const modelFrame = () => ({ encoding: MULAW_8K, data: Buffer.alloc(160, 0xff) });

const IVR: NonNullable<CallSessionParams["execution"]>["ivr"] = {
  maxPresses: 8,
  allowedDigits: "0123456789",
  onUnrecognized: "waitForHuman"
};

const postMenuLines = (diagnostics: string[]) =>
  diagnostics.filter((d) => d.startsWith("post-menu greeting: cue sent at +"));

async function ivrCall(
  opts: {
    openingDelivery?: OpeningDelivery | OpeningDeliveryByShape;
    execution?: CallSessionParams["execution"];
  } = {}
) {
  const f = fakes();
  const diagnostics: string[] = [];
  const cs = new CallSession({
    brief,
    guardrails,
    telephony: f.telephony,
    realtime: { ...f.realtime, openingDelivery: opts.openingDelivery ?? "prompt" },
    codec: fakeCodec,
    convert: fakeConvert,
    canConvert: fakeCanConvert,
    from: "+15555550142",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "test-model",
    execution: opts.execution ?? { ivr: IVR },
    onDiagnostic: (m) => diagnostics.push(m)
  });
  const handle = await cs.attach("call-1", new FakeSocket());
  const callerSays = (text: string) => f.emitTranscript({ speaker: "caller", text, isFinal: true });
  let n = 0;
  const press = async (digits: string) => {
    n += 1;
    await f.emitToolCall({ id: `press-${n}`, name: "press_digits", args: { digits } });
  };
  /** Carrier audio in real time: each 20 ms frame arrives once its 20 ms
   * have passed. `sound` is speech-like audio at that level, a list of steady
   * tones, or silence when omitted. */
  let samples = 0;
  const play = async (
    ms: number,
    sound?: number | { tones: number[]; dbfs: number }
  ): Promise<void> => {
    for (let t = 0; t < ms; t += FRAME_MS) {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
      f.emitInbound(
        sound === undefined
          ? silenceFrame()
          : typeof sound === "number"
            ? speechFrame(samples, sound)
            : toneFrame(samples, sound.tones, sound.dbfs)
      );
      samples += 160;
    }
  };
  return { f, cs, handle, diagnostics, callerSays, press, play };
}

describe("post-menu nudge constants", () => {
  it("R25: the post-menu timer is 5 s, past a ringback cadence's 4 s gap", () => {
    expect(POST_MENU_NUDGE_MS).toBe(5_000);
    expect(POST_MENU_WINDOW_MS).toBe(30_000);
    expect(MAX_GREETING_CUES_PER_CALL).toBe(2);
  });
});

describe("post-menu nudge on an IVR-declared call (transcript path)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("press accepted, a person speaks, the model stays silent: the cue goes out once, logged", async () => {
    const { f, diagnostics, callerSays, press } = await ivrCall();
    callerSays("Thank you for calling. For scheduling, press two.");
    await vi.advanceTimersByTimeAsync(1_000);
    await press("2");
    expect(f.toolResponses).toEqual([{ id: "press-1", result: "ok" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(POST_MENU_NUDGE_MS - 1);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(postMenuLines(diagnostics)).toEqual([
      `post-menu greeting: cue sent at +${3_000 + POST_MENU_NUDGE_MS}ms`
    ]);
    // More far-end speech after the cue: never a second cue for this press.
    callerSays("Hello? Anyone there?");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("a menu that pauses 3 s between options after the press: no cue in the pause", async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("1");
    callerSays("For new appointments, press one.");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    callerSays("To reschedule, press two.");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("far-end speech starting holds the timer until its transcript, which restarts it", async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Hi.");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitInterrupted();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    callerSays("This is Sam in scheduling, how can I help?");
    await vi.advanceTimersByTimeAsync(POST_MENU_NUDGE_MS - 1);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("the model speaks 2 s after the far end: no cue", async () => {
    const { f, diagnostics, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(2_000);
    f.emitModelAudio(modelFrame());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(postMenuLines(diagnostics)).toEqual([]);
  });

  it("model text with no audio yet cancels the post-menu cue", async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitTranscript({ speaker: "model", text: "Hi Sam, this is Ava", isFinal: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  /** Live (2026-10-03, Gemini): after the press and "Scheduling, this is
   * Sam.", the model's output transcription carried "<no speech>{pause}" and
   * a turn complete, no audio. That placeholder cancelled the cue and the call
   * sat silent to the silence cap. Word-less text must not cancel it. */
  it.each(["<no speech>{pause}", "{pause}", "<no speech>", "...", "  "])(
    "model text %j with no audio does not cancel the post-menu cue",
    async (text) => {
      const { f, diagnostics, callerSays, press } = await ivrCall();
      await press("2");
      callerSays("Scheduling, this is Sam.");
      await vi.advanceTimersByTimeAsync(1_000);
      f.emitTranscript({ speaker: "model", text, isFinal: false });
      f.emitTurnComplete();
      await vi.advanceTimersByTimeAsync(POST_MENU_NUDGE_MS - 1_000 - 1);
      expect(f.openingTrigger).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.openingTrigger).toHaveBeenCalledTimes(1);
      expect(f.openingTrigger).toHaveBeenCalledWith(CALL_ANSWERED_CUE);
      expect(postMenuLines(diagnostics)).toHaveLength(1);
    }
  );

  /** Fix round 1: a placeholder split across streamed fragments. */
  it.each([[["<", "no speech>{pause}"]], [["{pa", "use}"]], [["<no spe"]]])(
    "model fragments %j, then the turn closes, do not cancel the post-menu cue",
    async (fragments) => {
      const { f, callerSays, press } = await ivrCall();
      await press("2");
      callerSays("Scheduling, this is Sam.");
      await vi.advanceTimersByTimeAsync(1_000);
      for (const text of fragments) f.emitTranscript({ speaker: "model", text, isFinal: false });
      f.emitTurnComplete();
      await vi.advanceTimersByTimeAsync(POST_MENU_NUDGE_MS - 1_000);
      expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    }
  );

  it('model fragments "<" then "Hello" cancel the post-menu cue', async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitTranscript({ speaker: "model", text: "<", isFinal: false });
    f.emitTranscript({ speaker: "model", text: "Hello", isFinal: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("model audio still cancels the post-menu cue with a placeholder already in the turn", async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitTranscript({ speaker: "model", text: "<no speech>{pause}", isFinal: false });
    f.emitModelAudio(modelFrame());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it.each(["Hello", "Sure, one moment."])(
    "model text %j with no audio cancels the post-menu cue",
    async (text) => {
      const { f, callerSays, press } = await ivrCall();
      await press("2");
      callerSays("Scheduling, this is Sam.");
      await vi.advanceTimersByTimeAsync(1_000);
      f.emitTranscript({ speaker: "model", text, isFinal: false });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.openingTrigger).not.toHaveBeenCalled();
    }
  );

  it("another tool call (not a press) cancels the post-menu cue", async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(1_000);
    await f.emitToolCall({ id: "rec-1", name: "record_outcome", args: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it(`speech that starts more than ${POST_MENU_WINDOW_MS} ms after the press: no cue`, async () => {
    const { f, diagnostics, callerSays, press } = await ivrCall();
    await press("2");
    await vi.advanceTimersByTimeAsync(POST_MENU_WINDOW_MS + 1_000);
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(postMenuLines(diagnostics)).toEqual([]);
  });

  it("a second accepted press restarts the window", async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("1");
    await vi.advanceTimersByTimeAsync(25_000);
    await press("2");
    // 45 s after the first press, 20 s after the second.
    await vi.advanceTimersByTimeAsync(20_000);
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(POST_MENU_NUDGE_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it(`at most ${MAX_GREETING_CUES_PER_CALL} cues per call, across all presses`, async () => {
    const { f, diagnostics, callerSays, press } = await ivrCall();
    for (const digit of ["1", "2", "3"]) {
      await press(digit);
      callerSays("Please hold while I transfer you.");
      await vi.advanceTimersByTimeAsync(POST_MENU_NUDGE_MS + 1_000);
    }
    expect(f.openingTrigger).toHaveBeenCalledTimes(MAX_GREETING_CUES_PER_CALL);
    expect(postMenuLines(diagnostics)).toHaveLength(MAX_GREETING_CUES_PER_CALL);
  });

  it("a refused press opens no window", async () => {
    const { f, callerSays, press } = await ivrCall({
      execution: { ivr: { ...IVR, allowedDigits: "12" } }
    });
    await press("9");
    expect(f.toolResponses).toEqual([{ id: "press-1", result: "refused: digit not permitted" }]);
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("no press yet: an IVR-declared call is still never nudged (R20)", async () => {
    const { f, callerSays } = await ivrCall();
    callerSays("Thank you for calling. For appointments, press one.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a machine answer: never", async () => {
    const { f, callerSays, press } = await ivrCall();
    f.emitCallEvent({ type: "answered", answeredBy: "machine" });
    await press("2");
    callerSays("Please leave a message after the tone.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a machine verdict while the post-menu timer is pending cancels it", async () => {
    const { f, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Please leave a message");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitCallEvent({ type: "answered", answeredBy: "machine" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it('"turn" delivery: the opening went as a turn, a press sends nothing more', async () => {
    const { f, callerSays, press } = await ivrCall({ openingDelivery: "turn" });
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    await press("2");
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("the call ends while the timer is pending: nothing is sent and no timer is left", async () => {
    const { f, handle, callerSays, press } = await ivrCall();
    await press("2");
    callerSays("Scheduling, this is Sam.");
    await vi.advanceTimersByTimeAsync(1_000);
    await handle.stop("remote");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a meeting that dials through an IVR is never nudged after a press", async () => {
    const f = makeMeetingFakes();
    const diagnostics: string[] = [];
    const cs = new CallSession({
      ...f.params,
      realtime: { ...f.params.realtime, openingDelivery: "prompt" },
      execution: { ...f.params.execution, ivr: IVR },
      onDiagnostic: (m) => diagnostics.push(m)
    });
    await cs.attach("CA1", new FakeSocket());
    const sentAtConnect = f.openingTrigger.mock.calls.length;
    await f.emitToolCall({ id: "p1", name: "press_digits", args: { digits: "1" } });
    expect(f.toolResponses).toEqual([{ id: "p1", result: "ok" }]);
    f.emitTranscript({ speaker: "participant", text: "Hi everyone, let's start.", isFinal: true });
    for (let i = 0; i < 10; i += 1) f.emitInbound(silenceFrame());
    for (let i = 0; i < 30; i += 1) f.emitInbound(speechFrame(i * 160, VOICE_DBFS));
    for (let i = 0; i < 100; i += 1) f.emitInbound(silenceFrame());
    f.stubs.clock.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(sentAtConnect);
    expect(f.openingTrigger).not.toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(postMenuLines(diagnostics)).toEqual([]);
  });
});

describe("post-menu nudge on an IVR-declared call (voice-activity path)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("press, then a never-transcribed 800 ms utterance: cue at its end + POST_MENU_NUDGE_MS", async () => {
    const { f, diagnostics, press, play } = await ivrCall();
    await play(1_000);
    await press("2");
    await play(1_000);
    await play(800, VOICE_DBFS);
    // The utterance ends after 300 ms of unvoiced audio, at +3100 ms.
    await play(300);
    await play(POST_MENU_NUDGE_MS - FRAME_MS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(FRAME_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(postMenuLines(diagnostics)).toEqual([
      `post-menu greeting: cue sent at +${3_100 + POST_MENU_NUDGE_MS}ms`
    ]);
  });

  it("menu speech with a 3 s pause after the press: no cue in the pause", async () => {
    const { f, press, play } = await ivrCall();
    await play(500);
    await press("1");
    await play(1_500, VOICE_DBFS);
    await play(3_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(1_500, VOICE_DBFS);
    await play(3_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("an utterance already in progress at the press does not arm it", async () => {
    const { f, press, play } = await ivrCall();
    await play(500);
    await play(1_000, VOICE_DBFS);
    await press("2");
    await play(500, VOICE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("model audio before the timer fires: no cue", async () => {
    const { f, press, play } = await ivrCall();
    await play(500);
    await press("2");
    await play(800, VOICE_DBFS);
    await play(300);
    await play(2_000);
    f.emitModelAudio(modelFrame());
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("voice that starts more than the window after the press: no cue", async () => {
    const { f, press, play } = await ivrCall();
    await play(500);
    await press("2");
    await play(POST_MENU_WINDOW_MS + 500);
    await play(800, VOICE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a refused press opens no window for voice either", async () => {
    const { f, press, play } = await ivrCall({
      execution: { ivr: { ...IVR, allowedDigits: "12" } }
    });
    await play(500);
    await press("9");
    await play(800, VOICE_DBFS);
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  /** R25: US ringback (2 s on / 4 s off) after a transfer is voiced energy to
   * the VAD; armed by it, the timer would land on the next ring. A tone never
   * arms or holds the post-menu timer. */
  it("ringback (440 + 480 Hz, 2 s on / 4 s off) for 30 s after a press: no cue", async () => {
    const { f, press, play } = await ivrCall();
    await play(500);
    await press("2");
    for (let t = 0; t < 30_000; t += 6_000) {
      await play(2_000, { tones: RINGBACK_HZ, dbfs: -22 });
      await play(4_000);
    }
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a single steady 1 kHz tone after a press: no cue", async () => {
    const { f, press, play } = await ivrCall();
    await play(500);
    await press("2");
    await play(1_500, { tones: [1_000], dbfs: -20 });
    await play(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("speech-like modulated energy after a press, then 5 s of silence: cue", async () => {
    const { f, press, play } = await ivrCall();
    await play(500);
    await press("2");
    await play(1_200, VOICE_DBFS);
    await play(300);
    await play(POST_MENU_NUDGE_MS - FRAME_MS);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await play(FRAME_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  /** The press is placed on the VAD's media clock, not on wall time since
   * attach: with the first carrier frame arriving 1 s late, an utterance 200 ms
   * after the press is still post-press. */
  it("an utterance 200 ms after the press counts, even with a 1 s stream-start delay", async () => {
    const { f, press, play } = await ivrCall();
    await vi.advanceTimersByTimeAsync(1_000);
    await play(2_000);
    await press("2");
    await play(200);
    await play(800, VOICE_DBFS);
    await play(300);
    await play(POST_MENU_NUDGE_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });
});

describe("toneConcentration", () => {
  const spectrumOf = (frames: Frame[]) => {
    const acc = new ToneSpectrum();
    for (const fr of frames) acc.add(fr);
    return acc.concentration();
  };
  const frames = (n: number, make: (start: number) => Frame) =>
    Array.from({ length: n }, (_, i) => make(i * 160));

  it("ringback, a single tone and a DTMF-like dual tone are concentrated (≥ 0.8)", () => {
    expect(spectrumOf(frames(50, (s) => toneFrame(s, RINGBACK_HZ, -22)))).toBeGreaterThanOrEqual(
      TONE_CONCENTRATION
    );
    expect(spectrumOf(frames(50, (s) => toneFrame(s, [1_000], -20)))).toBeGreaterThanOrEqual(
      TONE_CONCENTRATION
    );
    expect(spectrumOf(frames(50, (s) => toneFrame(s, [697, 1_336], -20)))).toBeGreaterThanOrEqual(
      TONE_CONCENTRATION
    );
  });

  it("speech-like audio is not", () => {
    expect(spectrumOf(frames(50, (s) => speechFrame(s, -20)))).toBeLessThan(TONE_CONCENTRATION);
  });
});

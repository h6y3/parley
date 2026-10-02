import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallSession,
  MISSED_GREETING_NUDGE_MS,
  NUDGE_OPENING_WINDOW_MS
} from "../src/call-session.js";
import type { CallSessionParams } from "../src/call-session.js";
import { CALL_ANSWERED_CUE, MEETING_CONNECTED_CUE, planOpening } from "../src/render.js";
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
 * The missed-greeting nudge. On a two-party call whose opening rides in the
 * prompt, the agent waits for the far end's voice — and a greeting the model
 * never registered (answered instantly, or clipped: a smoke call transcribed
 * only "de Sesame") left it silent until the callee said hello again or the
 * silence cap ended the call. Once, and only when the far end has spoken and
 * the model has produced nothing, CallSession sends the plan's answered cue.
 */

const modelFrame = () => ({ encoding: MULAW_8K, data: Buffer.alloc(160, 0xff) });

async function twoPartyCall(
  openingDelivery: OpeningDelivery | OpeningDeliveryByShape = "prompt",
  execution?: CallSessionParams["execution"]
) {
  const f = fakes();
  const diagnostics: string[] = [];
  const cs = new CallSession({
    brief,
    guardrails,
    telephony: f.telephony,
    realtime: { ...f.realtime, openingDelivery },
    codec: fakeCodec,
    convert: fakeConvert,
    canConvert: fakeCanConvert,
    from: "+15555550142",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "test-model",
    ...(execution ? { execution } : {}),
    onDiagnostic: (m) => diagnostics.push(m)
  });
  const handle = await cs.attach("call-1", new FakeSocket());
  const callerSays = (text: string) => f.emitTranscript({ speaker: "caller", text, isFinal: true });
  return { f, cs, handle, diagnostics, callerSays };
}

const nudges = (diagnostics: string[]) =>
  diagnostics.filter((d) => d.startsWith("missed greeting: opening re-sent at +"));

describe("planOpening: the answered cue", () => {
  it("is planned only for a two-party call whose opening rides in the prompt", () => {
    expect(planOpening("prompt", false).answeredCue).toBe(CALL_ANSWERED_CUE);
    expect(planOpening({ twoParty: "prompt", meeting: "turn" }, false).answeredCue).toBe(
      CALL_ANSWERED_CUE
    );
    expect(planOpening("prompt", true).answeredCue).toBeUndefined();
    expect(planOpening("turn", false).answeredCue).toBeUndefined();
    expect(planOpening("turn", true).answeredCue).toBeUndefined();
  });

  it("is one short statement of fact, within the bound a user-turn provider accepts", () => {
    expect(CALL_ANSWERED_CUE).not.toContain("\n");
    // Deepgram's sendOpeningTrigger refuses more than twice the meeting cue.
    expect(CALL_ANSWERED_CUE.length).toBeLessThanOrEqual(2 * MEETING_CONNECTED_CUE.length);
  });
});

describe("CallSession missed-greeting nudge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("far end speaks, model silent for the full window: the cue is sent exactly once and logged", async () => {
    const { f, diagnostics, callerSays } = await twoPartyCall();
    expect(f.openingTrigger).not.toHaveBeenCalled();

    callerSays("de Sesame");
    await vi.advanceTimersByTimeAsync(MISSED_GREETING_NUDGE_MS - 1);
    expect(f.openingTrigger).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(nudges(diagnostics)).toEqual([
      `missed greeting: opening re-sent at +${MISSED_GREETING_NUDGE_MS}ms`
    ]);
  });

  it("the window runs from the END of the far end's speech: each fragment restarts it", async () => {
    const { f, callerSays } = await twoPartyCall();
    callerSays("Hello,");
    await vi.advanceTimersByTimeAsync(2_000);
    callerSays(" this is the front desk.");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("model audio inside the window: nothing is sent", async () => {
    const { f, diagnostics, callerSays } = await twoPartyCall();
    callerSays("Hello?");
    await vi.advanceTimersByTimeAsync(2_000);
    f.emitModelAudio(modelFrame());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(nudges(diagnostics)).toEqual([]);
  });

  it("the model already spoke before the far end: nothing is ever sent", async () => {
    const { f, callerSays } = await twoPartyCall();
    f.emitModelAudio(modelFrame());
    callerSays("Hello?");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a model tool call inside the window (a keypress) is the model acting: nothing is sent", async () => {
    const { f, callerSays } = await twoPartyCall();
    callerSays("For reservations, press one.");
    await f.emitToolCall({ id: "t1", name: "press_digits", args: { digits: "1" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("the far end never speaks: nothing is sent", async () => {
    const { f, callerSays } = await twoPartyCall();
    callerSays("");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("a second far-end utterance after the nudge: no second cue", async () => {
    const { f, diagnostics, callerSays } = await twoPartyCall();
    callerSays("Hello?");
    await vi.advanceTimersByTimeAsync(MISSED_GREETING_NUDGE_MS);
    callerSays("Hello? Anyone there?");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(nudges(diagnostics)).toHaveLength(1);
  });

  it("the call ends inside the window: nothing is sent and no timer is left", async () => {
    const { f, handle, callerSays } = await twoPartyCall();
    callerSays("Hello?");
    await vi.advanceTimersByTimeAsync(1_000);
    await handle.stop("remote");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  /** Deepgram sends one ConversationText per utterance, at its END, so a
   * short "Hi." followed by a long introduction would otherwise fire the cue
   * mid-speech — a user turn there, so the agent talks over the callee. Far-end
   * speech starting (onInterrupted: Deepgram UserStartedSpeaking, Gemini
   * interrupted) holds the window; the next transcript restarts it. */
  it("far-end speech starting holds the window until its transcript, which restarts it", async () => {
    const { f, callerSays } = await twoPartyCall();
    callerSays("Hi.");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitInterrupted();
    // Still speaking at +3500 ms, a full window after "Hi." — no cue.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    callerSays("This is the front desk, how can I help you today?");
    await vi.advanceTimersByTimeAsync(MISSED_GREETING_NUDGE_MS - 1);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    expect(f.openingTrigger).toHaveBeenCalledWith(CALL_ANSWERED_CUE);
  });

  /** R21: the nudge covers the opening only. */
  it(`far-end speech that starts after the opening window (${NUDGE_OPENING_WINDOW_MS} ms) arms nothing`, async () => {
    const { f, diagnostics, callerSays } = await twoPartyCall();
    await vi.advanceTimersByTimeAsync(11_000);
    callerSays("Hello?");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(nudges(diagnostics)).toEqual([]);
  });

  it("speech that started inside the window but is transcribed after it still counts", async () => {
    const { f, callerSays } = await twoPartyCall();
    await vi.advanceTimersByTimeAsync(9_000);
    f.emitInterrupted();
    await vi.advanceTimersByTimeAsync(4_000);
    callerSays("Good morning, thank you for calling, this is the front desk.");
    await vi.advanceTimersByTimeAsync(MISSED_GREETING_NUDGE_MS);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it("a call the carrier says a machine answered arms nothing", async () => {
    const { f, diagnostics, callerSays } = await twoPartyCall();
    f.emitCallEvent({ type: "answered", answeredBy: "machine" });
    callerSays("You have reached the voicemail of");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(nudges(diagnostics)).toEqual([]);
  });

  it("a machine verdict arriving while the window is pending cancels it", async () => {
    const { f, callerSays } = await twoPartyCall();
    callerSays("Hello, you have reached");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitCallEvent({ type: "answered", answeredBy: "machine" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("model text with no audio yet (Deepgram's text-before-audio order) cancels the nudge", async () => {
    const { f, callerSays } = await twoPartyCall();
    callerSays("Hello?");
    await vi.advanceTimersByTimeAsync(1_000);
    f.emitTranscript({ speaker: "model", text: "Hi, this is Ava", isFinal: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  it("whitespace-only far-end text does not arm it", async () => {
    const { f, callerSays } = await twoPartyCall();
    callerSays("   ");
    callerSays("\n\t");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
  });

  /** R20: a call that declares IVR navigation can face a menu that pauses for
   * longer than the window between options; the cue then would have the agent
   * talk over the menu. Such a call is never nudged. */
  it("an IVR-declared call is never nudged, however long the model stays silent", async () => {
    const { f, diagnostics, callerSays } = await twoPartyCall("prompt", {
      ivr: { maxPresses: 4, allowedDigits: "0123456789", onUnrecognized: "waitForHuman" }
    });
    callerSays("Thank you for calling. For appointments, press one.");
    await vi.advanceTimersByTimeAsync(MISSED_GREETING_NUDGE_MS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).not.toHaveBeenCalled();
    expect(nudges(diagnostics)).toEqual([]);
  });

  it('"turn" delivery: the opening already went as a turn, so nothing more is sent', async () => {
    const { f, callerSays } = await twoPartyCall("turn");
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
    callerSays("Hello?");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["prompt", "prompt"],
    ["per-shape", { twoParty: "prompt", meeting: "turn" }]
  ] as const)("a meeting (%s) is never nudged", async (_label, openingDelivery) => {
    const f = makeMeetingFakes();
    const diagnostics: string[] = [];
    const cs = new CallSession({
      ...f.params,
      realtime: { ...f.params.realtime, openingDelivery },
      onDiagnostic: (m) => diagnostics.push(m)
    });
    await cs.attach("CA1", new FakeSocket());
    const sentAtConnect = f.openingTrigger.mock.calls.length;
    f.emitTranscript({
      speaker: "participant",
      text: "Hi everyone, let's start.",
      isFinal: true
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.openingTrigger).toHaveBeenCalledTimes(sentAtConnect);
    expect(f.openingTrigger).not.toHaveBeenCalledWith(CALL_ANSWERED_CUE);
    expect(nudges(diagnostics)).toEqual([]);
  });
});

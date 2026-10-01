import {
  anchorConsentBoundary,
  buildToolDeclarations,
  defaultTimeZone,
  planOpening,
  type TodayInput,
  renderSystemInstruction,
  routeToolCall,
  ToolGate,
  type ToolResult,
  withOpening
} from "@parley/core";
import { composePolicy } from "@parley/policy";
import { DEFAULT_GEMINI_MODEL } from "@parley/realtime-gemini";
import type { CallScenario, ScenarioTurn } from "./call-scenario.js";
import type { EndedBecause, ScenarioRun } from "./call-scenario-evaluation.js";
import type { ScenarioTransport } from "./scenario-transport.js";

/**
 * Drive one scenario against a realtime model with a LIVE tool channel bound
 * to a recording mock carrier, so presses and hangups are captured as actions
 * rather than as things the model said it would do.
 *
 * SCOPE LIMIT, stated plainly: like runTextPreview, this bypasses
 * RealtimeProvider and talks to the vendor directly, through a
 * `ScenarioTransport` (`geminiTransport`, `deepgramTransport`). The
 * production interface deliberately exposes no "send a text turn", and
 * abusing sendOpeningTrigger to fake one would corrupt the very guarantee
 * under test. So this proves POLICY, GATE and MODEL behavior — it proves
 * nothing about the audio path, the codec, or DTMF timing against a real IVR.
 * Those remain the live gate's job.
 *
 * It shares the part that must be identical to production: ToolGate and
 * routeToolCall are the same code a real call runs, and so is `planOpening`,
 * which decides where the opening goes. Everything in this file
 * is shared by every transport; a transport owns only the wire, so the
 * scheduling below cannot differ between the providers being compared.
 *
 * THIS MAKES BILLED MODEL CALLS through whichever transport it is given.
 * Never run it in CI.
 *
 * SCHEDULING RULE — the one that decides whether a verdict means anything:
 * THE SCRIPT NEVER ADVANCES ON A TIMER. A callee line goes out when the model
 * finishes its turn, and a line gated on `afterPress` goes out when the press
 * lands. Every duration below is a TIMEOUT: it ends the run and names a
 * reason, and none of them can cause a turn to be delivered.
 *
 * That is not stylistic. Waiting a fixed duration and hoping the other side is
 * ready is the single largest cause of flaky asynchronous tests, and it cost
 * this harness three separate defects that each read as a Parley bug: a script
 * fed to a model that had gone silent (the fee it "ignored" was never
 * delivered), a scripted callee talking over a model mid-sentence, and a
 * one-second poll that burned a full 179-second session waiting for a press
 * that was never coming. Timers that only ever END a run cannot produce any of
 * those, because a run they end is reported as ended, not as evidence.
 */
// Production's model, so layers 1–3 measure what a real call runs rather than
// a legacy preview.
export const DEFAULT_SCENARIO_MODEL = DEFAULT_GEMINI_MODEL;

export interface ScenarioTimings {
  /** No event of any kind — speech, turn completion, or tool call — for this
   * long ends the run. A timeout, never a trigger. */
  stallMs: number;
  /** Spacing between the model completing its turn and the next callee line.
   * The trigger is the completion event; this only keeps the scripted callee
   * from replying in the same millisecond. */
  settleMs: number;
  /** Absolute cap on one scenario, whatever else is happening. */
  wallClockMs: number;
  /** The ring before pickup: how long after connect the FIRST callee line goes
   * out. The first line goes out on this clock and on nothing else — a phone
   * is picked up whether or not the caller has said anything, and a model
   * obeying the opening trigger completes no turn to wait on. It is one-shot
   * and never re-armed, and it never looks at model state: a model completing
   * a turn during the ring does not answer the phone early. Every later line
   * follows the ordinary rule.
   *
   * `0` (the default) is a ring of zero: the first line goes out right after
   * the opening trigger. It used to mean "the first line waits on the model's
   * first completed turn", and that is a wait on an event a CORRECT model never
   * produces — Gemini sends no `turnComplete` for a turn it does not take, so a
   * model staying silent as the trigger says left 8 of 10 billed runs `stalled`
   * before the callee had said a word. Where `planOpening` sent nothing at
   * connect (a `"prompt"` transport's two-party scenario) there is no trigger
   * to follow, and at `0` the first line goes out after `settleMs`.
   *
   * Above zero it also arms the trigger-silence check: any model speech before
   * the first line is delivered is recorded as `spokeBeforeCallee`. At `0`
   * there is no window for that to happen in. Must be shorter than `stallMs`,
   * or a silent ring could only ever end the run as a stall. */
  firstLineDelayMs?: number;
}

export const DEFAULT_SCENARIO_TIMINGS: ScenarioTimings = Object.freeze({
  stallMs: 30_000,
  settleMs: 1_200,
  wallClockMs: 180_000,
  firstLineDelayMs: 0
});

/** Diagnostic stream. A scenario failure is usually one of two very different
 * things — the model behaved wrongly, or the scripted callee ran ahead of it —
 * and the transcript alone cannot tell them apart. */
export type ScenarioTraceEvent =
  | { type: "turn-sent"; label: string; atMs: number }
  | { type: "turn-held"; label: string; waitingFor: string; atMs: number }
  | { type: "turn-released"; label: string; afterPress: string; atMs: number }
  | { type: "model-turn-complete"; atMs: number; textSoFar: number }
  /** `args` are the model's own arguments, as it sent them: what a
   * `record_outcome` claimed is only readable from here once the run is on
   * disk. Model output, never configuration — no key or environment. */
  | {
      type: "tool-call";
      name: string;
      args: Record<string, unknown>;
      result: string;
      atMs: number;
    }
  | { type: "watchdog"; reason: EndedBecause; atMs: number }
  | { type: "transport-diagnostic"; message: string; atMs: number }
  | { type: "transport-closed"; reason: string; atMs: number };

/** Omit over a union does not distribute, so `Omit<ScenarioTraceEvent, "atMs">`
 * collapses to the shared keys and rejects every variant's own fields. */
type TraceEventInput = ScenarioTraceEvent extends infer T
  ? T extends { atMs: number }
    ? Omit<T, "atMs">
    : never
  : never;

export async function runCallScenario(params: {
  scenario: CallScenario;
  /** One session's worth of wire. A transport is connected once, so pass a
   * fresh one per run. */
  transport: ScenarioTransport;
  timings?: ScenarioTimings;
  /** The clock and zone "today" is told in. Defaults to the wall clock and the
   * host zone, which is what a real call sends; a test pins both. */
  today?: TodayInput;
  trace?: (event: ScenarioTraceEvent) => void;
}): Promise<ScenarioRun> {
  const { scenario, transport } = params;
  const timings = params.timings ?? DEFAULT_SCENARIO_TIMINGS;
  const ringMs = timings.firstLineDelayMs ?? 0;
  if (ringMs > 0 && ringMs >= timings.stallMs) {
    throw new Error(
      `firstLineDelayMs (${ringMs}) must be shorter than stallMs (${timings.stallMs}): ` +
        `a model silent through the ring would be reported as stalled before pickup`
    );
  }

  const { brief, policy, execution } = scenario.envelope;
  // Same choice `CallSession.attach` makes, by the same helper, off the same
  // two inputs: the vendor's declared delivery and whether this is a meeting.
  // A meeting gets its own trigger for the reason `CallSession` gives —
  // `OPENING_TRIGGER` sent into a bridge resolves to "keep waiting", and a
  // harness that kept sending it would reproduce that defect for every
  // meeting scenario and report it as the model's behavior.
  const opening = planOpening(transport.openingDelivery, execution.meeting !== undefined);
  const rendered = renderSystemInstruction({
    persona: brief.persona,
    objective: brief.objective,
    facts: brief.facts,
    guardrails: composePolicy(policy, brief.preferences ?? []),
    // The same sentence `CallSession` sends, or the offline layers would
    // measure a prompt nobody's call carries.
    today: params.today ?? { now: new Date(), timeZone: defaultTimeZone() }
  });
  // A Parley constant, never scenario content — joined by the helper a real
  // call uses.
  const systemInstruction = withOpening(rendered, opening);

  const gate = new ToolGate(execution);
  const startedAt = Date.now();
  const trace = (event: TraceEventInput): void =>
    params.trace?.({ ...event, atMs: Date.now() - startedAt } as ScenarioTraceEvent);
  const toolCalls: ScenarioRun["toolCalls"] = [];
  let transcript = "";
  /** The same speech as `transcript`, cut at the model's own turn boundaries.
   *
   * A meeting verdict needs the cuts and the flat string cannot supply them:
   * "announced itself exactly once" is a count of turns that introduce the
   * agent, and "went quiet once note-taking began" is a question about which
   * side of one boundary the words fell on. Deriving either by re-splitting the
   * concatenation on punctuation would be inventing turn boundaries the session
   * already reported. */
  const modelTurns: string[] = [];
  let currentTurn = "";
  /** Index of the model turn that was in flight when `begin_notetaking` was
   * authorized, or undefined if it never was. `modelTurnsCompleted` counts
   * turns that have FINISHED, so it is exactly the 0-based index of the one
   * still open — the turn that carries the acknowledgment. Everything spoken in
   * a LATER turn is speech after the handoff.
   *
   * Cut at a turn boundary rather than at the character position the tool call
   * landed on, deliberately: output transcription arrives as deltas behind the
   * audio it describes, so text appended moments after the call can be
   * transcription of audio generated before it. A turn boundary cannot drift
   * that way. */
  let notetakingAuthorizedAtTurn: number | undefined;
  /** Whether the model said anything before the first callee line went out.
   * Only watched while a ring is configured: at `firstLineDelayMs: 0` the
   * first line follows the trigger at once, and anything "before" it would be
   * a race between two sends, not something the model chose to do. */
  let spokeBeforeCallee = false;
  /** The vendor's reason, when the session closed underneath the run. */
  let closedReason: string | undefined;
  let ended = false;
  let turnsDelivered = 0;

  // Recording mock carrier. Deliberately never fails: a scenario is about the
  // model's behavior, and injecting carrier faults belongs in the unit tests
  // where they are deterministic.
  const carrier = {
    sendDtmf: async () => {},
    endCall: async () => {
      ended = true;
    },
    beginNotetaking: async () => {}
  };

  /** The evidence the consent gate decides on, exactly as `CallSession`
   * supplies it: the callee lines actually delivered (timestamped, same as
   * `CallSession.heardBeforeConsentTimed`), when the model last completed a
   * turn (`requestedAt`, same as `CallSession`'s `lastModelUtteranceAt`),
   * and how many model turns have completed.
   *
   * Passed because `routeToolCall` defaults all three to empty/undefined,
   * and with the defaults `ToolGate.authorizeNotetaking` refuses EVERY
   * `begin_notetaking` no matter what the script said — the same defect
   * that, on the production path, refused every real call's handoff until
   * `CallSession` started passing them. A scenario scored against a gate
   * that can only ever refuse measures nothing about consent.
   *
   * `consentAnchor` is `CallSession.consentAnchorAt`, kept here for the same
   * reason and by the same shared function: `requestedAt` advances on every
   * completed turn, so once the model has acknowledged a go-ahead the boundary
   * has moved past the answer it is acknowledging. Deriving that here a second
   * way instead of calling `anchorConsentBoundary` is how the harness stops
   * measuring the code a real call runs. */
  const heard: { text: string; at: string }[] = [];
  let requestedAt: string | undefined;
  let consentAnchor: string | undefined;
  let modelTurnsCompleted = 0;
  const consentPhrases = execution.meeting
    ? [execution.meeting.consent.phrase, ...(execution.meeting.consent.additionalPhrases ?? [])]
    : [];

  const endedBecause = await new Promise<EndedBecause>((resolve, reject) => {
    let cursor = 0;
    /** Traced hold, for diagnosis only — never the release condition. A press
     * can land before the runner has ever looked at the gate, so keying the
     * release off "we already noticed we were holding" drops the turn on the
     * floor. The condition is the gate itself: see `nextGateOpen`. */
    let heldOn: string | undefined;
    /** Whether the model is mid-turn: set by any output, cleared by its
     * completion. */
    let modelTurnOpen = false;
    /** Set only when a line went out while the model's turn was still open —
     * which happens on exactly one path, a press releasing a gated line on a
     * transport that keeps the continuation's turn end apart. The
     * completion that lands a moment later belongs to the turn that ended
     * BEFORE that line, so advancing on it would talk over the model.
     *
     * This replaces a broader "require speech behind a completion" rule, which
     * ALSO discarded genuinely empty turns: a model with nothing to say still
     * finished, and the callee should speak next. Three scenarios in the first
     * live pair run stalled having delivered zero of eleven turns because of
     * it, and were reported inconclusive rather than judged. */
    let suppressNextCompletion = false;
    /** Set the moment the run is decided either way, so the close `finish`
     * asks for cannot be mistaken for the session dying underneath the run. */
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    /** One-shot timer for a line that is not a reply — see
     * `ScenarioTurn.unpromptedAfterMs`. Armed after each delivery (and at
     * connect) for the NEXT turn only, cleared the moment that turn goes out by
     * any route. It is one of only two timers here that can cause a delivery
     * (the ring below is the other), which is why it is armed for exactly one
     * turn at a time and never re-armed for a turn already sent. */
    let unprompted: ReturnType<typeof setTimeout> | undefined;
    /** The ring — see `ScenarioTimings.firstLineDelayMs`. Armed once, at
     * connect, for the first line only, whenever an opening trigger went out
     * or a ring is configured — at `0` too; it replaces the first line's own
     * unprompted timer rather than racing it, because nothing on the far end
     * can be heard before pickup. */
    let ring: ReturnType<typeof setTimeout> | undefined;
    /** False until the ring has elapsed. Until then nothing the model does may
     * deliver the first line. True from the start only on the one shape with
     * no ring at all: nothing sent at connect and `firstLineDelayMs: 0`. */
    let pickedUp = ringMs === 0 && opening.trigger === undefined;

    const wallClock = setTimeout(() => finish("wall-clock"), timings.wallClockMs);

    const stopTimers = (): void => {
      clearTimeout(ring);
      clearTimeout(watchdog);
      clearTimeout(settle);
      clearTimeout(unprompted);
      clearTimeout(wallClock);
    };

    const finish = (reason: EndedBecause): void => {
      if (settled) return;
      settled = true;
      stopTimers();
      transport.close().catch(() => {
        /* already closing */
      });
      resolve(reason);
    };

    /** The session failed or closed underneath a running scenario. Ended with
     * its own reason rather than left to the stall timer — a stall reads as a
     * model that went quiet, and sends someone tuning a rail that was never
     * put to the test — and resolved rather than rejected, because layers 2–3
     * read failure RATES and one flaky session must not abort the batch it is
     * part of. The vendor's reason goes to the trace and onto the run. */
    const transportClosed = (reason: string): void => {
      if (settled) return;
      closedReason = reason;
      trace({ type: "transport-closed", reason });
      finish("transport-closed");
    };

    /** The session never came up. Rejected: nothing was put to the model, and
     * the usual cause — a bad key, refused settings — fails every run the
     * same way, which is a configuration error to stop on, not a rate. */
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      stopTimers();
      reject(new Error(reason));
    };

    /** Restart the silence watchdog. Called on every inbound event, so an
     * active session never trips it. Its reason depends on where the run got
     * to: a script that has been fully delivered is waiting for the model to
     * close, which is a different failure from a model that went quiet
     * mid-conversation, and conflating them hid an `end_call` defect. */
    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        // `end_call` answers before it hangs up, so a successful hang-up is
        // normally seen on the model's next event. That event may never come
        // — a session can go quiet once the call is over — and the call is
        // over either way.
        const reason: EndedBecause = ended
          ? "model-ended"
          : cursor >= scenario.script.length
            ? "awaiting-closure"
            : "stalled";
        trace({ type: "watchdog", reason });
        finish(reason);
      }, timings.stallMs);
    };

    const pressesSoFar = (): readonly string[] => gate.snapshot().dtmf?.pressed ?? [];
    /** How many presses had landed when the line at `cursor` became the next
     * one due. A gate is satisfied only by presses after that point. */
    let pressesBeforeCurrent = 0;

    /** Whether `turn` is still waiting for its press. Only presses made since
     * it became the next line count, never the call's cumulative keys:
     * scripts gate several lines on the same digit, and "has 1 ever been
     * pressed" stays true for the rest of the call, which opened every later
     * gate at once and let any tool call — `record_outcome`, `end_call` —
     * release the next line, on Deepgram as a barge-in over the model. It
     * also keeps a blind press made before the menu was heard from counting
     * as navigating it. An empty `afterPress` gates nothing. */
    const gateHolds = (turn: ScenarioTurn): boolean =>
      turn.afterPress !== undefined &&
      turn.afterPress !== "" &&
      !pressesSoFar().slice(pressesBeforeCurrent).join("").includes(turn.afterPress);

    /** True when the next line is gated on a press that has now landed. A real
     * IVR answers a keypress at once, whether or not the caller has stopped
     * talking, so where the transport keeps the continuation's turn end apart
     * this releases immediately. Where it cannot, the line waits for that turn
     * end — see `ScenarioTransport.completesAfterToolResponse`. */
    const nextGateOpen = (): boolean => {
      const turn = scenario.script[cursor];
      return turn?.afterPress !== undefined && turn.afterPress !== "" && !gateHolds(turn);
    };

    /** Arm the unprompted timer for whatever turn is next, if that turn
     * declares one. Idempotent: any previously armed timer is cleared first, so
     * a turn delivered by an event rather than by its own timer cannot leave a
     * stale one running into its successor. */
    const armUnprompted = (): void => {
      clearTimeout(unprompted);
      const turn = scenario.script[cursor];
      if (turn?.unpromptedAfterMs === undefined) return;
      unprompted = setTimeout(tryAdvance, turn.unpromptedAfterMs);
    };

    /** Deliver the next callee line if — and only if — it is due. Called from
     * events, and from the unprompted timer for a line that is not a reply. */
    const tryAdvance = (): void => {
      if (ended) return finish("model-ended");
      if (cursor >= scenario.script.length) {
        // Closure is declared: the model still has `end_call` to make, and
        // closing the session the instant it stops speaking is how a run that
        // was about to close cleanly gets recorded as one that never did.
        if (execution.closure !== undefined) return armWatchdog();
        return finish("script-exhausted");
      }
      const turn = scenario.script[cursor];
      if (turn.afterPress && gateHolds(turn)) {
        if (heldOn !== turn.afterPress) {
          heldOn = turn.afterPress;
          trace({ type: "turn-held", label: turn.label, waitingFor: turn.afterPress });
        }
        // No retry timer. The press event calls back here; the watchdog is the
        // backstop if it never comes.
        return;
      }
      if (turn.afterPress !== undefined) {
        // Traced whether or not the runner ever had to wait: a press that lands
        // before the gate is first evaluated is the ordinary case, not an
        // exception, and a trace that only records slow releases would make the
        // fast ones look like turns that were never gated.
        trace({ type: "turn-released", label: turn.label, afterPress: turn.afterPress });
        heldOn = undefined;
      }
      // Only where the vendor is known to close the continuation with a
      // turn-end even when it is silent — see
      // `ScenarioTransport.completesAfterToolResponse`. Elsewhere the next
      // turn-end may be the reply to this very line, and skipping it stalls.
      if (modelTurnOpen && transport.completesAfterToolResponse) suppressNextCompletion = true;
      // Whatever route delivered this line, a settle still pending was armed
      // by a completion from BEFORE it, and firing it would send the next line
      // with no model turn in between. A press releasing a gated line is the
      // route that left it running.
      clearTimeout(settle);
      clearTimeout(unprompted);
      cursor += 1;
      pressesBeforeCurrent = pressesSoFar().length;
      turnsDelivered = cursor;
      heard.push({ text: turn.text, at: new Date().toISOString() });
      // A delivered line is the far end speaking — what CallSession tells the
      // gate on each far-end transcript. See `modelAudio` below for the other
      // half of the completed-record confirmation rule.
      gate.noteCallerSpeech();
      // Pin the boundary on the line itself, before the model's reply to it
      // can move `requestedAt` past it — see the declaration above.
      consentAnchor = anchorConsentBoundary(consentAnchor, heard, requestedAt, consentPhrases);
      trace({ type: "turn-sent", label: turn.label });
      transport.sendCalleeText(turn.text);
      armWatchdog();
      armUnprompted();
    };

    transport
      .connect({
        systemInstruction,
        tools: buildToolDeclarations(execution),
        on: {
          toolCall: (call) => {
            // Where in the script the call landed, taken when it ARRIVES: a
            // record made in reply to the offer and one made after the callee
            // agreed are otherwise the same entry.
            const deliveredAtCall = cursor;
            void routeToolCall({
              call,
              gate,
              carrier,
              callId: "SCENARIO",
              heard,
              requestedAt: consentAnchor ?? requestedAt,
              modelTurnsCompleted,
              respond: (result: ToolResult) => {
                toolCalls.push({
                  name: call.name,
                  args: call.args,
                  result,
                  turnsDelivered: deliveredAtCall
                });
                trace({ type: "tool-call", name: call.name, args: call.args, result });
                if (call.name === "begin_notetaking" && result === "ok") {
                  notetakingAuthorizedAtTurn ??= modelTurnsCompleted;
                }
                transport.sendToolResponse(call, result);
                if (ended) return finish("model-ended");
                modelTurnOpen = true;
                armWatchdog();
                // A press is the event a gated turn is waiting for, so only a
                // press may release one — an unrelated tool call must not
                // shove the script forward while the model is mid-turn. Nor
                // may a press answer the phone during the ring.
                if (call.name === "press_digits" && pickedUp && nextGateOpen()) {
                  if (transport.completesAfterToolResponse) tryAdvance();
                  // Where a line sent on top of the continuation would be
                  // folded into it or dropped (Deepgram), the continuation's
                  // own turn end releases the line through the ordinary
                  // completion → settle → tryAdvance path, the gate now open.
                  // A settle armed before the press must not beat it there.
                  else clearTimeout(settle);
                }
              }
            });
          },
          // The fact, never the bytes. CallSession feeds the gate the same
          // fact from the provider's audio frames; without it a completed
          // record made after the model last spoke would pass offline and be
          // refused on the call.
          modelAudio: () => gate.noteModelAudio(),
          modelText: (delta) => {
            if (ringMs > 0 && heard.length === 0) spokeBeforeCallee = true;
            transcript += delta;
            currentTurn += delta;
            modelTurnOpen = true;
            // Speech is activity, not completion. Advancing here would let
            // the scripted callee talk over a model mid-sentence.
            armWatchdog();
          },
          turnComplete: () => {
            trace({ type: "model-turn-complete", textSoFar: transcript.length });
            armWatchdog();
            modelTurnOpen = false;
            // Pushed even when empty. A turn in which the model said nothing
            // is a real event and the ordinary correct one in a waiting room,
            // so dropping it would renumber every turn after it and put the
            // consent handoff on the wrong side of its own boundary.
            modelTurns.push(currentTurn);
            currentTurn = "";
            modelTurnsCompleted += 1;
            requestedAt = new Date().toISOString();
            if (suppressNextCompletion) {
              suppressNextCompletion = false;
              return;
            }
            // A turn completed during the ring is model state, and the first
            // line waits for pickup, not for the model.
            if (!pickedUp) return;
            clearTimeout(settle);
            settle = setTimeout(tryAdvance, timings.settleMs);
          },
          closed: (reason) => transportClosed(reason),
          diagnostic: (message) => trace({ type: "transport-diagnostic", message })
        }
      })
      .then(() => {
        if (settled) return;
        // Planned above. On a "prompt" transport's two-party scenario nothing
        // is sent here — the callee's first line is the opening, as on a
        // real call there.
        if (opening.trigger !== undefined) transport.sendCalleeText(opening.trigger);
        armWatchdog();
        if (!pickedUp) {
          // At `0` as well as above it. Waiting on the model's reply to the
          // trigger instead is waiting on silence, which is the reply the
          // trigger asks for. A bridge's hold loop is covered by this too: it
          // starts playing whether or not the leg that just joined says
          // anything.
          ring = setTimeout(() => {
            pickedUp = true;
            tryAdvance();
          }, ringMs);
          return;
        }
        // Nothing was sent at connect and there is no ring: no reply is coming
        // and nothing is ringing, so the callee speaks first, after the usual
        // spacing.
        settle = setTimeout(tryAdvance, timings.settleMs);
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  });

  // A run ended by a watchdog or the wall clock can be cut off mid-turn, and
  // what was said in that turn is still evidence — a model reciting its rails
  // until the stall timer fires must not be scored as having said nothing.
  if (currentTurn !== "") modelTurns.push(currentTurn);

  return {
    transcript,
    modelTurns,
    ...(notetakingAuthorizedAtTurn === undefined ? {} : { notetakingAuthorizedAtTurn }),
    toolCalls,
    snapshot: gate.snapshot(),
    endedBecause,
    turnsDelivered,
    ...(ringMs > 0 ? { spokeBeforeCallee } : {}),
    ...(closedReason === undefined ? {} : { closedReason })
  };
}

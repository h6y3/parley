import { GoogleGenAI, Modality } from "@google/genai";
import {
  anchorConsentBoundary,
  buildToolDeclarations,
  MEETING_OPENING_TRIGGER,
  OPENING_TRIGGER,
  renderSystemInstruction,
  routeToolCall,
  ToolGate,
  type ToolResult
} from "@parley/core";
import { composePolicy } from "@parley/policy";
import type { CallScenario } from "./call-scenario.js";
import type { EndedBecause, ScenarioRun } from "./call-scenario-evaluation.js";

/**
 * Drive one scenario against Gemini Live with a LIVE tool channel bound to a
 * recording mock carrier, so presses and hangups are captured as actions rather
 * than as things the model said it would do.
 *
 * SCOPE LIMIT, stated plainly: like runTextPreview, this bypasses
 * RealtimeProvider and talks to the genai SDK directly. The production
 * interface deliberately exposes no "send a text turn", and abusing
 * sendOpeningTrigger to fake one would corrupt the very guarantee under test.
 * So this proves POLICY, GATE and MODEL behavior — it proves nothing about the
 * audio path, the codec, or DTMF timing against a real IVR. Those remain the
 * live gate's job.
 *
 * It shares the part that must be identical to production: ToolGate and
 * routeToolCall are the same code a real call runs.
 *
 * THIS MAKES BILLED GEMINI CALLS. Never run it in CI.
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
export const DEFAULT_SCENARIO_MODEL = "gemini-3.1-flash-live-preview";

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
}

export const DEFAULT_SCENARIO_TIMINGS: ScenarioTimings = Object.freeze({
  stallMs: 30_000,
  settleMs: 1_200,
  wallClockMs: 180_000
});

type GenAIFactory = (options: {
  apiKey: string;
  httpOptions: { apiVersion: string };
}) => GoogleGenAI;

/** Diagnostic stream. A scenario failure is usually one of two very different
 * things — the model behaved wrongly, or the scripted callee ran ahead of it —
 * and the transcript alone cannot tell them apart. */
export type ScenarioTraceEvent =
  | { type: "turn-sent"; label: string; atMs: number }
  | { type: "turn-held"; label: string; waitingFor: string; atMs: number }
  | { type: "turn-released"; label: string; afterPress: string; atMs: number }
  | { type: "model-turn-complete"; atMs: number; textSoFar: number }
  | { type: "tool-call"; name: string; result: string; atMs: number }
  | { type: "watchdog"; reason: EndedBecause; atMs: number };

/** Omit over a union does not distribute, so `Omit<ScenarioTraceEvent, "atMs">`
 * collapses to the shared keys and rejects every variant's own fields. */
type TraceEventInput = ScenarioTraceEvent extends infer T
  ? T extends { atMs: number }
    ? Omit<T, "atMs">
    : never
  : never;

export async function runCallScenario(params: {
  apiKey: string;
  scenario: CallScenario;
  model?: string;
  genAIFactory?: GenAIFactory;
  timings?: ScenarioTimings;
  trace?: (event: ScenarioTraceEvent) => void;
}): Promise<ScenarioRun> {
  const { scenario } = params;
  const model = params.model ?? DEFAULT_SCENARIO_MODEL;
  const timings = params.timings ?? DEFAULT_SCENARIO_TIMINGS;
  const factory: GenAIFactory = params.genAIFactory ?? ((o) => new GoogleGenAI(o));
  const ai = factory({ apiKey: params.apiKey, httpOptions: { apiVersion: "v1beta" } });

  const { brief, policy, execution } = scenario.envelope;
  const systemInstruction = renderSystemInstruction({
    persona: brief.persona,
    objective: brief.objective,
    facts: brief.facts,
    guardrails: composePolicy(policy, brief.preferences ?? [])
  });

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
     * which happens on exactly one path, a press releasing a gated line. The
     * completion that lands a moment later belongs to the turn that ended
     * BEFORE that line, so advancing on it would talk over the model.
     *
     * This replaces a broader "require speech behind a completion" rule, which
     * ALSO discarded genuinely empty turns: a model with nothing to say still
     * finished, and the callee should speak next. Three scenarios in the first
     * live pair run stalled having delivered zero of eleven turns because of
     * it, and were reported inconclusive rather than judged. */
    let suppressNextCompletion = false;
    let session:
      | {
          sendRealtimeInput: (i: { text: string }) => void;
          sendToolResponse: (p: unknown) => void;
          close: () => void;
        }
      | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    /** One-shot timer for a line that is not a reply — see
     * `ScenarioTurn.unpromptedAfterMs`. Armed after each delivery (and at
     * connect) for the NEXT turn only, cleared the moment that turn goes out by
     * any route. It is the one timer here that can cause a delivery, which is
     * why it is armed for exactly one turn at a time and never re-armed for a
     * turn already sent. */
    let unprompted: ReturnType<typeof setTimeout> | undefined;

    const wallClock = setTimeout(() => finish("wall-clock"), timings.wallClockMs);

    const finish = (reason: EndedBecause): void => {
      clearTimeout(watchdog);
      clearTimeout(settle);
      clearTimeout(unprompted);
      clearTimeout(wallClock);
      try {
        session?.close();
      } catch {
        /* already closing */
      }
      resolve(reason);
    };

    /** Restart the silence watchdog. Called on every inbound event, so an
     * active session never trips it. Its reason depends on where the run got
     * to: a script that has been fully delivered is waiting for the model to
     * close, which is a different failure from a model that went quiet
     * mid-conversation, and conflating them hid an `end_call` defect. */
    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        const reason: EndedBecause =
          cursor >= scenario.script.length ? "awaiting-closure" : "stalled";
        trace({ type: "watchdog", reason });
        finish(reason);
      }, timings.stallMs);
    };

    const pressedSoFar = (): string => (gate.snapshot().dtmf?.pressed ?? []).join("");

    /** True when the next line is gated on a press that has now landed. A real
     * IVR answers a keypress at once, whether or not the caller has stopped
     * talking, so this releases immediately. */
    const nextGateOpen = (): boolean => {
      const turn = scenario.script[cursor];
      return turn?.afterPress !== undefined && pressedSoFar().includes(turn.afterPress);
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
      if (turn.afterPress && !pressedSoFar().includes(turn.afterPress)) {
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
      if (modelTurnOpen) suppressNextCompletion = true;
      clearTimeout(unprompted);
      cursor += 1;
      turnsDelivered = cursor;
      heard.push({ text: turn.text, at: new Date().toISOString() });
      // Pin the boundary on the line itself, before the model's reply to it
      // can move `requestedAt` past it — see the declaration above.
      consentAnchor = anchorConsentBoundary(consentAnchor, heard, requestedAt, consentPhrases);
      trace({ type: "turn-sent", label: turn.label });
      session?.sendRealtimeInput({ text: turn.text });
      armWatchdog();
      armUnprompted();
    };

    ai.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          systemInstruction,
          // Mirror what CallSession sends on a real call. Without this the
          // scenario session drifts from production behaviour over a long
          // conversation, and a scenario that does not behave like a call is
          // not evidence about calls.
          contextWindowCompression: { slidingWindow: {} },
          ...(buildToolDeclarations(execution).length > 0
            ? {
                tools: [
                  {
                    functionDeclarations: buildToolDeclarations(execution).map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: t.parametersJsonSchema
                    }))
                  }
                ]
              }
            : {})
        },
        callbacks: {
          onopen: () => {},
          onmessage: (message) => {
            for (const fc of message.toolCall?.functionCalls ?? []) {
              if (!fc.id || !fc.name) continue;
              const call = { id: fc.id, name: fc.name, args: fc.args ?? {} };
              void routeToolCall({
                call,
                gate,
                carrier,
                callId: "SCENARIO",
                heard,
                requestedAt: consentAnchor ?? requestedAt,
                modelTurnsCompleted,
                respond: (result: ToolResult) => {
                  toolCalls.push({ name: call.name, args: call.args, result });
                  trace({ type: "tool-call", name: call.name, result });
                  if (call.name === "begin_notetaking" && result === "ok") {
                    notetakingAuthorizedAtTurn ??= modelTurnsCompleted;
                  }
                  session?.sendToolResponse({
                    functionResponses: [
                      { id: call.id, name: call.name, response: { output: result } }
                    ]
                  });
                  if (ended) return finish("model-ended");
                  modelTurnOpen = true;
                  armWatchdog();
                  // A press is the event a gated turn is waiting for. Only an
                  // open gate advances anything — an unrelated tool call must
                  // not shove the script forward while the model is mid-turn.
                  if (nextGateOpen()) tryAdvance();
                }
              });
            }
            const delta = message.serverContent?.outputTranscription?.text;
            if (delta) {
              transcript += delta;
              currentTurn += delta;
              modelTurnOpen = true;
              // Speech is activity, not completion. Advancing here would let
              // the scripted callee talk over a model mid-sentence.
              armWatchdog();
            }
            if (message.serverContent?.turnComplete) {
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
              clearTimeout(settle);
              settle = setTimeout(tryAdvance, timings.settleMs);
            }
          },
          onerror: (event) => {
            clearTimeout(watchdog);
            clearTimeout(settle);
            clearTimeout(wallClock);
            reject(
              new Error(
                event?.error instanceof Error ? event.error.message : "unknown Gemini Live error"
              )
            );
          },
          onclose: () => {}
        }
      })
      .then((s) => {
        session = s as unknown as typeof session;
        // Same choice `CallSession.attach` makes, off the same signal, for the
        // same reason: `OPENING_TRIGGER` sent into a bridge resolves to "keep
        // waiting" and two live meeting calls sat silent on it. A harness that
        // kept sending it would REPRODUCE that defect for every meeting
        // scenario — including any scenario written to check the fix — and
        // report it as the model's behavior.
        session?.sendRealtimeInput({
          text: execution.meeting ? MEETING_OPENING_TRIGGER : OPENING_TRIGGER
        });
        armWatchdog();
        // The first line may itself be unprompted — a bridge's hold loop starts
        // playing whether or not the leg that just joined says anything.
        armUnprompted();
      })
      .catch(reject);
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
    turnsDelivered
  };
}

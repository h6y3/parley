import { GoogleGenAI, Modality } from "@google/genai";
import {
  buildToolDeclarations,
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
  let ended = false;
  let turnsDelivered = 0;

  // Recording mock carrier. Deliberately never fails: a scenario is about the
  // model's behavior, and injecting carrier faults belongs in the unit tests
  // where they are deterministic.
  const carrier = {
    sendDtmf: async () => {},
    endCall: async () => {
      ended = true;
    }
  };

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

    const wallClock = setTimeout(() => finish("wall-clock"), timings.wallClockMs);

    const finish = (reason: EndedBecause): void => {
      clearTimeout(watchdog);
      clearTimeout(settle);
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

    /** Deliver the next callee line if — and only if — it is due. Called from
     * events, never from a timer. */
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
      cursor += 1;
      turnsDelivered = cursor;
      trace({ type: "turn-sent", label: turn.label });
      session?.sendRealtimeInput({ text: turn.text });
      armWatchdog();
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
                respond: (result: ToolResult) => {
                  toolCalls.push({ name: call.name, args: call.args, result });
                  trace({ type: "tool-call", name: call.name, result });
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
              modelTurnOpen = true;
              // Speech is activity, not completion. Advancing here would let
              // the scripted callee talk over a model mid-sentence.
              armWatchdog();
            }
            if (message.serverContent?.turnComplete) {
              trace({ type: "model-turn-complete", textSoFar: transcript.length });
              armWatchdog();
              modelTurnOpen = false;
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
        session?.sendRealtimeInput({ text: OPENING_TRIGGER });
        armWatchdog();
      })
      .catch(reject);
  });

  return { transcript, toolCalls, snapshot: gate.snapshot(), endedBecause, turnsDelivered };
}

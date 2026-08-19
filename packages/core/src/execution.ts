/** The BINDING half of a call envelope. Everything here is enforced by the
 * server; nothing said on the call can reach it. Contrast `Brief` and the
 * composed policy guardrails, which become prose and are therefore advisory.
 *
 * Presence declares capability — there is no `enabled` flag anywhere. A tool is
 * declared to the model if and only if its block is present, so a
 * half-configured envelope is inert rather than half-armed. */
export interface CallExecution {
  /** Declares `press_digits`. `maxPresses` is the whole-call budget counted in
   * individual keys; `allowedDigits` is the permitted key set; `onUnrecognized`
   * is what to do when no menu option matches the primed goal. */
  ivr?: {
    maxPresses: number;
    allowedDigits: string;
    onUnrecognized: "zeroOut" | "waitForHuman" | "hangUp";
  };
  /** Declares `end_call`. `requireOutcomeBeforeEnd` makes the first hangup
   * attempt refuse until an outcome is recorded — once only, so a model that
   * cannot produce one is never trapped on a live, billing call. */
  closure?: { requireOutcomeBeforeEnd: boolean };
  /** Declares `record_outcome` and the field set it must fill. */
  outcome?: { fields: { name: string; description: string }[] };
  /** BINDING ceiling on what `record_outcome` may write into `field`.
   *
   * The advisory counterpart is `policy.authority.spend`, which becomes prose
   * the model can be talked around — and was, on three of four cells quoted
   * above it. This is the half that cannot be. The envelope schema requires the
   * two to be declared together and to agree, so a call that has spending
   * authority and somewhere to record it cannot leave the record unbounded. */
  spendCeiling?: { field: string; limit: number };
  /** Server-side timers. Non-negotiable; they fire mid-sentence if they must. */
  limits?: { maxDurationSeconds: number; maxSilenceSeconds?: number };
  /** Silence the VAD waits out before handing the turn back. The provider
   * default is 700ms, which a service rep checking a schedule blows straight
   * through. */
  turnDetection?: { silenceMs: number };
  /** Twilio answering-machine detection. Opt-in because it costs answer latency
   * and a per-call fee on every call, answered by a machine or not. */
  detection?: { mode: "enable" | "detectMessageEnd" };
}

export type ToolName = "press_digits" | "end_call" | "record_outcome";

/** THE COMPLETE SET of strings the server may ever hand back to the model from a
 * tool call.
 *
 * A tool result is text the model reads, which makes it the one surface where a
 * callee could smuggle instructions inward — so no result is ever built from an
 * argument, an utterance, or an error message. This union IS the invariant, and
 * `tool-gate.test.ts` asserts membership mechanically. Adding a case here is a
 * deliberate act with a test attached; interpolating a value into one is a
 * security bug. */
export type ToolResult =
  | "ok"
  | "recorded"
  | "refused: tool not available"
  | "refused: press budget exhausted"
  | "refused: digit not permitted"
  | "refused: could not send"
  | "refused: record the outcome first"
  | "refused: invalid arguments"
  | "refused: that amount is above the limit for this call";

export const TOOL_RESULTS: readonly ToolResult[] = Object.freeze([
  "ok",
  "recorded",
  "refused: tool not available",
  "refused: press budget exhausted",
  "refused: digit not permitted",
  "refused: could not send",
  "refused: record the outcome first",
  "refused: invalid arguments",
  "refused: that amount is above the limit for this call"
] as const);

export interface RecordedOutcome {
  status: "completed" | "partial" | "failed";
  fields: Record<string, string>;
  recordedAt: string;
}

/** Provider-neutral tool declaration. The Gemini adapter maps this onto
 * `FunctionDeclaration` (via `parametersJsonSchema`); another provider maps it
 * onto its own equivalent. */
export interface ToolDeclaration {
  name: ToolName;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

/** Instructions for USING a tool live in its description, never in
 * systemInstruction. That keeps the prompt purely policy-composed, and gives a
 * caller sending raw `guardrails[]` identical behavior without having to write
 * any prose about keypads. */
export function buildToolDeclarations(execution: CallExecution): ToolDeclaration[] {
  const decls: ToolDeclaration[] = [];
  if (execution.ivr) {
    // `onUnrecognized` was declared, validated, preset-defaulted and consumed by
    // the test harness — and never told to the model, which is the same defect
    // class as a provider method with no caller. Without this sentence the model
    // has no way to know a fallback exists, and a tree whose options do not
    // match the goal simply strands the call.
    // Named anti-pattern, not just a positive instruction. The positive form —
    // "if no option matches, press 0" — was in place for a full matrix and the
    // model still pressed 1 for "new installations" when it wanted service
    // scheduling, twice. It was not ignoring the rule; it had decided an option
    // DID match. The sentence has to refuse the near-miss explicitly.
    const fallback: Record<NonNullable<CallExecution["ivr"]>["onUnrecognized"], string> = {
      zeroOut:
        "Do NOT press an option that is merely the closest match to what you need. If none of the " +
        "options is the one you want, 0 is the right answer — press 0 to reach an operator.",
      waitForHuman:
        "Do NOT press an option that is merely the closest match to what you need. If none of the " +
        "options is the one you want, do not press anything — stay on the line and wait for a person.",
      hangUp:
        "Do NOT press an option that is merely the closest match to what you need. If none of the " +
        "options is the one you want, end the call rather than guessing at one."
    };
    decls.push({
      name: "press_digits",
      description:
        `Press keys on the telephone keypad to choose an option in an automated menu. ` +
        // Found on the FIRST live call, and unreachable from the harness: the
        // model's opening action was a keypress, before the callee had said
        // anything at all. The caller heard a DTMF tone, no greeting, and hung
        // up. Every generated scenario opens with a menu turn, so in the
        // harness the model has always already heard a menu before it can
        // press — the "nothing has been said yet" state only exists on a real
        // call. Pressing is a RESPONSE to a menu, never an opening move.
        `NEVER press anything until you have actually heard a recorded menu offer you options. ` +
        `Do not press at the start of the call, and do not press because you expect a menu — wait ` +
        `and listen first. If a person answers, talk to them; do not press anything. ` +
        `Use this only once a recorded menu has offered options and one of them is the one you ` +
        `need; pass only the keys to press, for example "1". ` +
        `${fallback[execution.ivr.onUnrecognized]} ` +
        `You may press at most ${execution.ivr.maxPresses} keys on this call, and only these keys: ` +
        `${execution.ivr.allowedDigits}. Never press while a person is speaking.`,
      parametersJsonSchema: {
        type: "object",
        properties: { digits: { type: "string", description: 'The keys to press, e.g. "1".' } },
        required: ["digits"]
      }
    });
  }
  if (execution.closure) {
    // The old description — "use this once you have said goodbye" — described a
    // state, not an action, and the wrap-up rail it pairs with talks only about
    // SPEECH: confirm, thank, say goodbye. A model that did exactly that then
    // stopped, and the line sat open. Measured: on a 20-cell matrix every
    // failing cell ended `awaiting-closure`, one of them with nothing else
    // wrong at all.
    //
    // The load-bearing sentence is the one stating the consequence. The model
    // has no way to observe that the call is still up, and cannot infer from a
    // silent line that it is the one holding it open.
    //
    // This lives in the tool description rather than in the wrap-up rail
    // because the description exists if and only if the tool does. Putting
    // "end the call" in `composePolicy` would tell a model with no `end_call`
    // tool to use one — the same defect inverted.
    const outcomeFirst =
      execution.closure.requireOutcomeBeforeEnd && execution.outcome !== undefined
        ? ` Record the outcome before you call this: the first attempt to end without one is refused.`
        : "";
    decls.push({
      name: "end_call",
      description:
        `End the call and hang up the line. Saying goodbye does NOT hang up — the call stays ` +
        `connected until you call this, so call it as soon as you have said goodbye and the ` +
        `conversation is complete. Do not wait for the other person to hang up.${outcomeFirst}`,
      parametersJsonSchema: {
        type: "object",
        properties: { reason: { type: "string", description: "Short reason the call is ending." } },
        required: ["reason"]
      }
    });
  }
  if (execution.outcome) {
    const fieldList = execution.outcome.fields
      .map((f) => `${f.name} (${f.description})`)
      .join("; ");
    // Declare each field as its own typed property rather than handing the model
    // an untyped `{type: "object"}` bag with the names buried in prose.
    // Measured, not assumed: with a bare object the model called record_outcome
    // with `fields: {}` even after audibly agreeing a price and a date on the
    // same call. Models reliably fill declared properties; they skip free-form
    // objects.
    const fieldProperties: Record<string, unknown> = {};
    for (const f of execution.outcome.fields) {
      fieldProperties[f.name] = { type: "string", description: f.description };
    }
    // Tell the model the bound it is held to. The gate refuses over-ceiling
    // records either way, but a refusal the model could not have predicted
    // wastes a turn on a live call and invites it to retry the same number.
    //
    // "If and only if" is load-bearing. An earlier wording said "if the price
    // went above that, set status to partial", and a model on a call where no
    // price was quoted AT ALL read it as applying: it booked the appointment it
    // was sent to book and recorded the call partial anyway.
    const ceilingNote = execution.spendCeiling
      ? ` If — and only if — they quote a price above ${execution.spendCeiling.limit}, leave ` +
        `${execution.spendCeiling.field} empty and set status to partial; recording an amount above ` +
        `${execution.spendCeiling.limit} will be refused.`
      : "";
    decls.push({
      name: "record_outcome",
      description:
        // "Before ending it" made recording the last thing on the call, and the
        // call is not the model's to end. `requireOutcomeBeforeEnd` arms this
        // on `end_call` only, so every other way a call finishes — the far end
        // hanging up, which on a real call is the NORMAL ending, or a duration
        // or silence cap — leaves no record at all. Nothing can be recorded
        // after the line drops. The only fix is to record earlier, so the
        // instruction is now "as soon as you know", not "before you hang up".
        // "As soon as the call has settled" asks the model to judge a moment,
        // and it kept judging it to be the end — or never. Saying goodbye is
        // an observable act, and it is the exact edge of the window: after it,
        // the other person may hang up at any moment and nothing can be
        // recorded once the line is down. Measured at 7% of runs recording
        // nothing at all, and on a live call where the callee hung up on the
        // farewell.
        `Record what this call achieved. Call this BEFORE you say goodbye — not after, and not ` +
        `while you are wrapping up. Once you have said goodbye the other person may hang up at any ` +
        `moment, and nothing can be recorded after the line drops, so the record has to exist ` +
        `first. If you learn something after recording, call this again; the most recent call is ` +
        `the one that counts. ` +
        // The three statuses were named and never defined, so the model supplied
        // its own readings. Measured on one matrix: a call that booked exactly
        // what it set out to book was recorded "partial", and a call where a
        // dispatcher said the booking system was down was recorded "failed"
        // while the suite expected "partial". One of those is the model being
        // wrong and one is the suite being wrong — an undefined term produces
        // both.
        // Judge by the objective, not by information gathered. The first
        // version of these definitions said failed meant "they could not do
        // it", and a model that booked the appointment it was sent to book —
        // on a call where the company does not quote prices by policy — read
        // an unanswered price question as the call having failed. Twice.
        `Set status by whether what you called to arrange got arranged, NOT by how much you ` +
        `found out. Exactly one of: "completed" — the thing you called to arrange is arranged; ` +
        `"partial" — you reached someone and moved it forward but it is not arranged, such as no ` +
        `suitable time, or a price you were not authorised to accept; "failed" — nothing was ` +
        `arranged and nothing moved forward, because you reached nobody who could help or they ` +
        `declined. A question they could not answer is not a failure: if what you called to ` +
        `arrange is arranged, that is "completed" even with questions left open. ` +
        `Fill every field you learned on the call: ${fieldList}. If the call never established a ` +
        // Every field is declared `required`, which is what stopped the model
        // calling this with an empty bag — but a required field invites
        // invention. Measured: `agreedAmount: "89"` on a call where no price was
        // ever mentioned, and `"0"` on another. Naming the correct empty value
        // costs one sentence; the alternative is a fabricated number in a
        // structured field somebody downstream will act on.
        `field, set it to an empty string. Never guess, estimate, or write a placeholder such as 0 ` +
        `or N/A — an empty string is the right answer for something this call did not establish.` +
        `${ceilingNote}`,
      parametersJsonSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["completed", "partial", "failed"],
            description: "How the call ended."
          },
          fields: {
            type: "object",
            description: "The declared fields and their values.",
            properties: fieldProperties,
            required: execution.outcome.fields.map((f) => f.name)
          }
        },
        required: ["status", "fields"]
      }
    });
  }
  return decls;
}

/** Decides every tool call. Stateful — it tracks budget and what has been
 * recorded — but performs NO I/O: the caller executes what this authorizes.
 * That split is what makes every rule standing between a callee's persuasion and
 * a real action testable without a phone line or a model. */
export class ToolGate {
  private readonly pressed: string[] = [];
  private pressedDigits = 0;
  private refusedPresses = 0;
  private outcome?: RecordedOutcome;
  private endRefusedOnce = false;

  constructor(
    private readonly execution: CallExecution,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  declaredTools(): ToolName[] {
    return buildToolDeclarations(this.execution).map((d) => d.name);
  }

  /** Decide a press. Does NOT consume budget — `commitPress` does, and only once
   * the carrier has actually accepted the digits. */
  authorizePress(digits: string): ToolResult {
    const ivr = this.execution.ivr;
    if (!ivr) return "refused: tool not available";
    if (digits.length === 0) return this.refusePress("refused: digit not permitted");
    for (const ch of digits) {
      if (!ivr.allowedDigits.includes(ch)) return this.refusePress("refused: digit not permitted");
    }
    if (this.pressedDigits + digits.length > ivr.maxPresses) {
      return this.refusePress("refused: press budget exhausted");
    }
    return "ok";
  }

  /** Charge the budget. Call only after the carrier accepted the send. */
  commitPress(digits: string): void {
    this.pressed.push(digits);
    this.pressedDigits += digits.length;
  }

  /** The carrier rejected the send. A carrier fault is not the model's error, so
   * it costs no budget — otherwise a flaky REST call would silently eat the
   * model's ability to navigate the tree. */
  failPress(): ToolResult {
    return this.refusePress("refused: could not send");
  }

  authorizeEnd(): ToolResult {
    const closure = this.execution.closure;
    if (!closure) return "refused: tool not available";
    const needsOutcome = closure.requireOutcomeBeforeEnd && this.execution.outcome !== undefined;
    if (needsOutcome && !this.outcome && !this.endRefusedOnce) {
      // One-shot. A model that cannot produce an outcome must never be trapped
      // on a live, billing call by a gate it has no way to satisfy.
      this.endRefusedOnce = true;
      return "refused: record the outcome first";
    }
    return "ok";
  }

  recordOutcome(status: RecordedOutcome["status"], fields: Record<string, unknown>): ToolResult {
    const declared = this.execution.outcome;
    if (!declared) return "refused: tool not available";
    const allowed = new Set(declared.fields.map((f) => f.name));
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (allowed.has(key)) kept[key] = String(value);
    }

    // Refuse BEFORE writing anything. A partial record — the appointment kept,
    // the price dropped — is worse than either alternative: downstream would
    // read a booked visit with no price as a free one.
    const ceiling = this.execution.spendCeiling;
    if (ceiling) {
      const amount = readAmount(kept[ceiling.field]);
      if (amount !== null && amount > ceiling.limit)
        return "refused: that amount is above the limit for this call";
    }

    this.outcome = { status, fields: kept, recordedAt: this.now() };
    return "recorded";
  }

  snapshot(): { outcome?: RecordedOutcome; dtmf?: { pressed: string[]; refused: number } } {
    return {
      ...(this.outcome ? { outcome: this.outcome } : {}),
      ...(this.execution.ivr
        ? { dtmf: { pressed: [...this.pressed], refused: this.refusedPresses } }
        : {})
    };
  }

  private refusePress(result: ToolResult): ToolResult {
    this.refusedPresses += 1;
    return result;
  }
}

/** Read a recorded amount as a number, or null when there is nothing to bound.
 *
 * Stated plainly because the limit matters: this reads DIGITS. An amount
 * written out in words is not bounded here, and the prose rail is the only
 * thing covering that case. A tolerant parser that guessed at words would be a
 * worse trade — it would refuse legitimate free-text values and still not be
 * complete. */
function readAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Minimal carrier surface routeToolCall needs. Narrower than TelephonyProvider
 * on purpose, so the scenario harness can supply a recording mock without
 * implementing origination or webhooks. */
export interface ToolCarrier {
  sendDtmf(callId: string, digits: string): Promise<void>;
  endCall(reason: string): Promise<void>;
}

/** Route ONE model-requested tool call through the gate to the carrier.
 *
 * Extracted rather than living inside CallSession because the scenario harness
 * drives the identical path. Two copies would drift, and the copy under test
 * would stop being the code that runs on a real call — which is the entire
 * value of testing it.
 *
 * Every branch answers the call. An unanswered tool call stalls the model's
 * turn, which on a live call is dead air. */
export async function routeToolCall(params: {
  call: { id: string; name: string; args: Record<string, unknown> };
  gate: ToolGate;
  carrier: ToolCarrier;
  callId: string;
  respond: (result: ToolResult) => void;
}): Promise<void> {
  const { call, gate, carrier, callId, respond } = params;

  switch (call.name) {
    case "press_digits": {
      const digits = call.args.digits;
      if (typeof digits !== "string") return respond("refused: invalid arguments");
      const decision = gate.authorizePress(digits);
      if (decision !== "ok") return respond(decision);
      try {
        await carrier.sendDtmf(callId, digits);
      } catch {
        return respond(gate.failPress());
      }
      gate.commitPress(digits);
      return respond("ok");
    }

    case "end_call": {
      const decision = gate.authorizeEnd();
      // Answer BEFORE hanging up. After endCall the session is closing and the
      // response would never reach the model.
      respond(decision);
      if (decision === "ok") {
        const reason =
          typeof call.args.reason === "string" ? call.args.reason : "model ended the call";
        await carrier.endCall(reason);
      }
      return;
    }

    case "record_outcome": {
      const { status, fields } = call.args;
      const validStatus = status === "completed" || status === "partial" || status === "failed";
      const validFields = typeof fields === "object" && fields !== null && !Array.isArray(fields);
      if (!validStatus || !validFields) return respond("refused: invalid arguments");
      return respond(gate.recordOutcome(status, fields as Record<string, unknown>));
    }

    default:
      return respond("refused: tool not available");
  }
}

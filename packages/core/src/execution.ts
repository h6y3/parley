import type { MeetingExecution } from "./meeting.js";
import type { SpeakerRole } from "./types.js";

/** Twilio's accepted alphabet for `SendDigits`: keypad characters plus `w`
 * (half-second pause) and `W` (one-second pause) — the two are how a fixed
 * script can wait out a bridge's own prompt without any feedback to time
 * against. Shared by the envelope schema (`@parley/policy`'s
 * `callExecutionSchema`) and the provider boundary
 * (`@parley/telephony-twilio`'s `TwilioTelephonyProvider.originate`) so the
 * two validations cannot drift apart. */
export const SEND_DIGITS_PATTERN = /^[0-9*#wW]+$/;

/** Assumed ceiling on `SendDigits`' length. Twilio's docs were not consulted
 * over the network while this was built (no network call was available), and
 * do not appear to state a hard limit for this field the way they do for,
 * say, an E.164 number — so this assumes 32 characters is a safe ceiling for
 * a meeting ID plus a passcode plus a few pause characters, rather than quote
 * a figure never verified against the live API. Revisit if Twilio's docs are
 * checked directly. */
export const SEND_DIGITS_MAX_LENGTH = 32;

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
  /** Declares the call is a conference-bridge join rather than a two-party
   * call, and raises the ceilings `limits.maxDurationSeconds` and
   * `ivr.maxPresses` may carry — see `MEETING_MAX_DURATION_SECONDS` and
   * `MEETING_MAX_PRESSES` in `./meeting.js`. Absent, those ceilings stay at
   * the ordinary-call maxima. */
  meeting?: MeetingExecution;
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
  /** Carrier-side DTMF played automatically once the carrier answers the
   * call — Twilio's `SendDigits`, set at origination, before the model, the
   * media stream, or anything on our end of the call exists. For
   * deterministic entry into a bridge whose prompts are known in advance (a
   * conference ID and passcode, said in a fixed order at a fixed pace), as
   * distinct from `ivr`/`press_digits` above, which exists for menus the
   * model must listen to and react to live. Both are legitimate and serve
   * different callees: a scripted bridge join has no menu to listen for, and
   * a live IVR has no fixed script to play.
   *
   * Lives here, not nested under `meeting` — any bridge or predictable IVR
   * can use it, not only a meeting join, so it is not meeting-specific.
   *
   * Declares NO tool, and deliberately carries no `policy` pairing, unlike
   * `ivr` (paired with `policy.ivr`) and `meeting` (paired with
   * `policy.meeting.announce`, see `MeetingExecution` above). Those pairings
   * exist because the model must be told, in prose, what it is permitted to
   * do with a tool the envelope declares. `SendDigits` is played by the
   * carrier before the model is ever connected to the call — there is
   * nothing for the model to be told, so there is nothing to pair.
   *
   * `sendDigits` typically carries a bridge passcode and MUST be treated as a
   * secret end to end — see `OriginateParams.sendDigits`. */
  dial?: {
    /** Twilio's `SendDigits` alphabet and length ceiling — see
     * `SEND_DIGITS_PATTERN` / `SEND_DIGITS_MAX_LENGTH` above, which this
     * field's envelope-schema validation (`@parley/policy`) and the provider
     * boundary (`@parley/telephony-twilio`) both enforce independently, so a
     * malformed envelope is rejected before a call is ever originated rather
     * than only at the provider. */
    sendDigits: string;
  };
}

export type ToolName = "press_digits" | "end_call" | "record_outcome" | "begin_notetaking";

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
  /** An accepted `end_call`. Every other tool's acceptance is still "ok".
   *
   * A tool answer starts a spoken turn — always on Deepgram, and Gemini's
   * BLOCKING tools continue the one they interrupted — and CallSession waits
   * for that turn before it hangs up. A bare "ok" gave the model nothing to
   * do with it, so on live calls it spent the turn on one more goodbye. This
   * says nothing more is wanted. (It said "the line is closing" first, and a
   * live Gemini call answered it aloud with "The line is closed.") */
  | "ok — say nothing more"
  | "recorded"
  /** A `record_outcome` accepted on a call that declares `end_call`. A bare
   * "recorded" left the turn it opens directionless, and the model filled it
   * with another round of thanks before ending. Without `end_call` the plain
   * "recorded" stands: naming a tool the model does not have is its own
   * defect. The goodbye is conditional (a goodbye already said means end_call alone):
   * a record made mid-call, or a partial one, must not push the model toward
   * hanging up — `end_call`'s own description says having recorded an
   * outcome is not a reason to end. */
  | "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
  | "refused: tool not available"
  | "refused: press budget exhausted"
  | "refused: digit not permitted"
  | "refused: could not send"
  | "refused: record the outcome first — call record_outcome now without mentioning it"
  | "refused: incomplete outcome"
  /** A `completed` record on a two-party call when the model has spoken since
   * the far end last did — so nobody has agreed to what it last said. See
   * `ToolGate.recordOutcome`. It says what to do instead, because the model
   * reads it and goes on speaking, and "do not end the call" because the
   * refused record has just left nothing for `end_call` to close on. */
  | "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call"
  | "refused: invalid arguments"
  | "refused: that amount is above the limit for this call"
  /** Nobody has answered a question, because none has been asked: the model
   * has not completed a turn, or has said nothing at all. Distinct from the
   * refusal below, which means the room DID speak and none of it was a
   * go-ahead. Those two returned the identical string until 2026-08-21, so
   * the one line a live failure left on disk could not say which had
   * happened — part of why it took a live call to find. */
  | "refused: the agent has not asked for consent yet"
  | "refused: the go-ahead phrase has not been spoken";

export const TOOL_RESULTS: readonly ToolResult[] = Object.freeze([
  "ok",
  "ok — say nothing more",
  "recorded",
  "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call",
  "refused: tool not available",
  "refused: press budget exhausted",
  "refused: digit not permitted",
  "refused: could not send",
  "refused: record the outcome first — call record_outcome now without mentioning it",
  "refused: incomplete outcome",
  "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call",
  "refused: invalid arguments",
  "refused: that amount is above the limit for this call",
  "refused: the agent has not asked for consent yet",
  "refused: the go-ahead phrase has not been spoken"
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
    // The second half of the description says when NOT to end. Measured in
    // billed runs: one model called this ~2 s after pressing a key, when it
    // should have been waiting for the menu; another kept asking questions
    // after the callee said goodbye. The first sentence alone only ever pushed
    // toward ending, so the boundary has to be stated from both sides.
    //
    // This lives in the tool description rather than in the wrap-up rail
    // because the description exists if and only if the tool does. The rail
    // (2026-09-30) says "record the outcome, say one short goodbye, and end
    // the call" in generic words, as the voicemail rails always have; naming
    // `end_call` there would tell a model with no such tool to use one — the
    // same defect inverted. The tool-specific consequence stays here.
    const outcomeFirst =
      execution.closure.requireOutcomeBeforeEnd && execution.outcome !== undefined
        ? ` Record the outcome before you call this: the first attempt to end without one is refused.`
        : "";
    decls.push({
      name: "end_call",
      description:
        `End the call and hang up the line. Saying goodbye does NOT hang up — the call stays ` +
        `connected until you call this, so call it as soon as you have said goodbye and the ` +
        `conversation is complete. Do not wait for the other person to hang up.` +
        ` Never call this while waiting for the other side — after a keypress, while on hold or ` +
        `being transferred, or before anyone has answered. Having recorded an outcome is not a ` +
        `reason to end. Once they have said goodbye, ask nothing further: record what you have ` +
        `and end the call.${outcomeFirst}`,
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
  if (execution.meeting) {
    // The ONLY place "do not call before asking" and "the server can refuse
    // and you may ask again" are stated. `meetingConsentRequest`
    // (`@parley/policy`) used to repeat both, in harsher terms — "ends your
    // turn immediately... has nowhere to go" — and a model reading both this
    // description and that instruction in the same prompt got two
    // independent warnings about the same irreversible loss and no
    // instruction to actually act: two live calls in a row never called this
    // tool at all. Do not put either warning back into the instruction —
    // that duplication is the defect that shipped, not a coincidence to fix
    // twice.
    decls.push({
      name: "begin_notetaking",
      description:
        "Call this ONCE, after you have announced yourself and asked whether anyone objects to " +
        "note-taking, at the moment you hear the go-ahead. It starts note-taking and ends your " +
        "ability to speak for the rest of the meeting, so do not call it before you have asked. " +
        "The server independently checks that the go-ahead was spoken; if it was not, this is " +
        "refused and you may ask again.",
      parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false }
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
  private notetakingBegan = false;
  /** Whether the model has produced audio since the far end last spoke —
   * true from the model's first audio frame until the far end's next words.
   * Starts false: before anyone has said anything, nothing has been proposed
   * either. See `recordOutcome`. */
  private modelSpokeSinceCaller = false;

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

  /** The model produced audio. Fed by CallSession from the provider's AUDIO
   * frames, never from its transcript: Gemini's output transcription can trail
   * the audio it describes, and the audio precedes the tool call it leads to. */
  noteModelAudio(): void {
    this.modelSpokeSinceCaller = true;
  }

  /** The far end said something (a non-empty transcript, final or not — Gemini
   * never marks its input transcription final). */
  noteCallerSpeech(): void {
    this.modelSpokeSinceCaller = false;
  }

  authorizeEnd(): ToolResult {
    const closure = this.execution.closure;
    if (!closure) return "refused: tool not available";
    const needsOutcome = closure.requireOutcomeBeforeEnd && this.execution.outcome !== undefined;
    if (needsOutcome && !this.outcome && !this.endRefusedOnce) {
      // One-shot. A model that cannot produce an outcome must never be trapped
      // on a live, billing call by a gate it has no way to satisfy.
      this.endRefusedOnce = true;
      return "refused: record the outcome first — call record_outcome now without mentioning it";
    }
    return "ok — say nothing more";
  }

  recordOutcome(status: RecordedOutcome["status"], fields: Record<string, unknown>): ToolResult {
    const declared = this.execution.outcome;
    if (!declared) return "refused: tool not available";
    // Provider-side function schemas improve model behaviour, but tool
    // arguments are still untrusted input at this binding gate. Require every
    // declared field independently here; otherwise a provider that skips JSON
    // schema validation can write a partial record that downstream mistakes
    // for a complete one. Empty strings are valid and deliberately mean "the
    // call did not establish this value".
    for (const field of declared.fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, field.name)) {
        return "refused: incomplete outcome";
      }
      if (typeof fields[field.name] !== "string") {
        return "refused: incomplete outcome";
      }
    }
    const allowed = new Set(declared.fields.map((f) => f.name));
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (allowed.has(key)) kept[key] = String(value);
    }

    // Nobody has agreed to anything the model said after the far end last
    // spoke. Live, Gemini 3.8, 2026-10-01: the callee offered "Monday at 9:26
    // a.m." and the model answered in ONE turn — "That works perfectly. So we
    // can schedule the cleaning for Monday, October 5th at 9:30 am. Thank you
    // so much for your help. Goodbye." — then recorded `completed` at 9:30
    // and ended the call. Three prompt-level fixes did not stop it, so it is
    // enforced here, on the one status that claims an agreement exists.
    // `partial` and `failed` claim none and are never held to it. A meeting
    // is not a two-party negotiation, and is not gated.
    //
    // It cannot trap the model: `end_call`'s refusal is one-shot, so a model
    // that never gets its confirmation still hangs up on its second
    // `end_call` — with no completed record, which is the true state.
    if (status === "completed" && !this.execution.meeting && this.modelSpokeSinceCaller) {
      return "refused: they have not confirmed what you just said — read the arrangement back exactly as they said it, wait for their yes, then record; do not end the call";
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
    // Direct the turn this answer opens only when the call can close itself:
    // `closure` is what declares `end_call` (see buildToolDeclarations).
    return this.execution.closure
      ? "recorded — if you already thanked them or said goodbye, call end_call now without saying anything; otherwise say one short goodbye, then call end_call"
      : "recorded";
  }

  /** Decide whether note-taking may begin.
   *
   * The MODEL requests the handoff; the SERVER decides it. Which words were
   * said, by whom, and in what order is otherwise model judgment — the same
   * class as policy.authority.spend, which was talked around on three of four
   * measured cells and was answered with execution.spendCeiling rather than a
   * better sentence. This is that answer for consent.
   *
   * `heard` is the pre-consent buffer's caller-side utterances, timestamped;
   * the caller already holds them in memory. `requestedAt` is the boundary
   * `findConsentMatch` enforces: an utterance only counts if it arrived at or
   * after that instant, because consent follows a request and an utterance
   * said earlier is an answer to nothing. Pass the boundary that was in force
   * when the room ANSWERED, not the agent's latest utterance —
   * `anchorConsentBoundary` below, and the live failure in its doc.
   * `modelTurnsCompleted` guards the other direction: firing EARLY is the
   * dangerous mode, because after the handoff there is no speaking plane left
   * to correct or apologise with.
   *
   * The two refusals are DIFFERENT FACTS and say so. "The agent has not asked
   * for consent yet" is about our own side of the call — no completed turn, or
   * nothing said in it. "The go-ahead phrase has not been spoken" is about the
   * room's: it was asked and what came back was not a yes. Both returned the
   * second string until 2026-08-21, so a live refusal's one line on disk could
   * not distinguish "we never asked" from "they never agreed", which is part of
   * why the boundary defect above needed a live call to surface.
   *
   * What this does NOT establish is WHO spoke. Slice A does not diarize, so a
   * stranger who heard the phrase said aloud satisfies it exactly as the
   * principal would. It is a record that the words were spoken before
   * note-taking began, and any stronger claim about it is false. */
  authorizeNotetaking(
    heard: readonly HeardUtterance[],
    requestedAt: string | undefined,
    modelTurnsCompleted: number
  ): ToolResult {
    const meeting = this.execution.meeting;
    if (!meeting) return "refused: tool not available";
    if (modelTurnsCompleted < 1) return "refused: the agent has not asked for consent yet";
    // A turn can complete carrying no words at all, so a completed turn is not
    // proof the agent spoke. With no utterance of ours there is no boundary,
    // nothing can be an answer, and saying so is more accurate than reporting
    // the room's silence for our own.
    if (requestedAt === undefined) return "refused: the agent has not asked for consent yet";
    const match = findConsentMatch(heard, requestedAt, this.consentPhrases);
    if (!match) return "refused: the go-ahead phrase has not been spoken";
    this.notetakingBegan = true;
    return "ok";
  }

  /** The declared consent phrases, primary first, exactly as
   * `authorizeNotetaking` matches them. Empty when no meeting is declared.
   *
   * Exists for the debug dump in `routeToolCall`, which is off unless
   * `PARLEY_DEBUG_CONSENT` is set. Nothing on a normal-operation path may read
   * this into anything that gets written down: an accepted phrase is exactly
   * what someone reading a log would want, and every ordinary diagnostic in
   * this file is built to be incapable of carrying one. */
  get consentPhrases(): readonly string[] {
    const meeting = this.execution.meeting;
    if (!meeting) return [];
    return [meeting.consent.phrase, ...(meeting.consent.additionalPhrases ?? [])];
  }

  get notetakingAuthorized(): boolean {
    return this.notetakingBegan;
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

/** Lowercase and collapse every run of whitespace to one space. Speech
 * transcripts arrive with inconsistent casing and line breaks, and a phrase
 * split across two lines is the same phrase.
 *
 * Exported so `CallSession.buildConsentReceipt` normalizes against the exact
 * same rule this gate does — two independently maintained copies agreed
 * today and would have silently drifted apart the next time either changed
 * (punctuation stripping being the obvious next rule), landing the gate and
 * the receipt on different readings of the same phrase. */
export function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** One heard utterance, timestamped. `at` is an ISO-8601 instant — every
 * producer in this codebase stamps it from the same clock (`CallSession`'s
 * injectable `now`, or the harness's wall clock), so plain string comparison
 * orders correctly. Deliberately minimal: this is everything `findConsentMatch`
 * needs to decide, not everything a caller may know about the utterance —
 * `CallSession` passes richer objects (carrying `speaker` too) and they satisfy
 * this structurally. */
export interface HeardUtterance {
  text: string;
  at: string;
  /** Who said it, when the caller happens to know — `CallSession` tags the far
   * end at source (`RealtimeConnectParams.speakerRole`), the scenario harness
   * has only scripted lines and carries none.
   *
   * Read by NO decision in this file. It is here for the consent debug dump
   * alone, which reports it because "who said the thing the gate rejected" is
   * the first question anyone asks of one, and reaching it through a cast
   * would be reading a field the type says does not exist. Any rule that ever
   * decided on this would be claiming diarization Parley does not have — see
   * `authorizeNotetaking`'s closing paragraph. */
  speaker?: SpeakerRole;
}

/** Negation vocabulary `findConsentMatch` checks for OUTSIDE a matched
 * phrase's span (see `hasNegationOutsideSpan` below). This is the layer the
 * previous fix (`e29165f`, `@parley/policy`'s `schema.ts`) could not reach:
 * that commit rejects a configured PHRASE whose own negated form collides
 * with it ("please do" / "please dont"). It has nothing to say about a
 * phrase like "go ahead" — a perfectly good phrase — appearing inside a
 * sentence that refuses it ("don't go ahead"). Measured directly against
 * `ToolGate.authorizeNotetaking`, that gap let four real refusals through as
 * grants; see `consent-negation-outside-span.test.ts`.
 *
 * Matched on WORD BOUNDARIES ONLY. Substring presence is exactly the bug
 * this rule exists to fix in the phrase layer — reusing it here would
 * reintroduce the identical error one level down: "notes" contains "no" and
 * "cannot" contains "not", and neither word refuses anything.
 *
 * Curated to entries this codebase has direct evidence for, not padded to
 * "every English negation":
 *   - "no", "not", "never", "nope", "nah" — the plain refusal words a room
 *     actually says.
 *   - "rather not" — a common polite refusal shape; kept as its own entry
 *     even though the bare "not" token already covers it, because a reader
 *     auditing this list for "is a polite refusal handled" should find it
 *     named, not have to prove it's subsumed.
 *   - the "n't" contractions a bare "not" cannot reach: "don't"/"doesn't"/
 *     "didn't"/"won't"/"can't"/"isn't"/"wouldn't" — each listed WITH and
 *     WITHOUT the apostrophe, because the one real refusal on record in this
 *     codebase (call `CA0573ebc91a165c9c0230f8890915f87b`, see `e29165f`)
 *     was transcribed "dont", no apostrophe. Speech-to-text is not obliged
 *     to punctuate a contraction correctly, and a list that only matched the
 *     punctuated spelling would miss the exact shape that motivated this
 *     file's sibling fix.
 *   - "object", "objection" — a direct verbal objection. Still governed by
 *     the outside-the-span rule below, which is exactly what keeps "no
 *     objection" granting when it is the configured phrase itself: both
 *     words land INSIDE that phrase's own matched span.
 *   - "unhappy", "uncomfortable" — the two words the policy layer's own
 *     consent question (`@parley/policy`'s `constants.ts`) is written to
 *     invite as an answer; a check on consent language should recognize the
 *     words that language is designed to prompt. */
const NEGATION_TOKENS: readonly string[] = [
  "no",
  "not",
  "rather not",
  "never",
  "nope",
  "nah",
  "don't",
  "dont",
  "doesn't",
  "doesnt",
  "didn't",
  "didnt",
  "won't",
  "wont",
  "can't",
  "cant",
  "isn't",
  "isnt",
  "wouldn't",
  "wouldnt",
  "object",
  "objection",
  "unhappy",
  "uncomfortable"
];

/** `\b` on both sides of every token, so e.g. "not" only matches the standalone
 * word — never the tail of "cannot" or the head of "notable". Built once at
 * module load: it is immutable and only ever consumed through `matchAll`,
 * which clones the regex internally, so a single shared instance carries no
 * `lastIndex` state between calls. Special regex characters are escaped
 * defensively even though the current token list needs none, so adding a
 * token later cannot silently change what this matches. */
const NEGATION_PATTERN = new RegExp(
  `\\b(?:${NEGATION_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "g"
);

/** Every negation-token match in `normalized`, with its character span.
 * `matchAll` requires the `g` flag `NEGATION_PATTERN` carries and does not
 * mutate it, so this is safe to call repeatedly on different strings. */
function negationMatches(normalized: string): { start: number; end: number }[] {
  return [...normalized.matchAll(NEGATION_PATTERN)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length
  }));
}

/** `true` if `normalized` contains a negation token whose span is not fully
 * contained within `[spanStart, spanEnd)` — the matched phrase's own span.
 * A token entirely INSIDE the span is part of the phrase that was agreed to
 * ("no problem", "no objection"); a token anywhere else is someone negating
 * that agreement. Partial overlap (which the token list's shapes cannot
 * actually produce, since both phrases and tokens split on word boundaries)
 * is treated as OUTSIDE — fail closed, not fail lenient, on an edge case
 * that should not occur. */
function hasNegationOutsideSpan(normalized: string, spanStart: number, spanEnd: number): boolean {
  return negationMatches(normalized).some((m) => !(m.start >= spanStart && m.end <= spanEnd));
}

/** Find the newest heard utterance that (a) arrived AT OR AFTER `requestedAt`,
 * (b) contains one of `phrases` as a normalized substring, and (c) is not
 * itself a refusal — see `hasNegationOutsideSpan` above. Returns which
 * phrase matched and the utterance that matched it, or `undefined` if none
 * qualify.
 *
 * ORDERING is the actual guard, not phrase length. A live call found the
 * length-only version of this wrong: the declared phrase was "go ahead and
 * take notes", the principal said "go ahead" — a normal, short, human
 * reply — several times, and a substring match against a four-word phrase
 * refused every one of them. The risk a length floor was standing in for is
 * narrower than length: an utterance that arrives BEFORE the agent has asked
 * anything (someone says "go ahead" to a colleague about something else, and
 * it later counts as permission for a question nobody had posed yet). That
 * risk has a precise shape — arrival order — so this checks order instead of
 * demanding a phrase long enough that nobody says it by accident.
 *
 * `at >= requestedAt`, not `>`: two utterances recorded in the same
 * synchronous tick (the common case in a test, and possible in production if
 * a transcript event and the request land in the same event-loop turn) get
 * the same clock reading. That is a recording-granularity tie, not evidence
 * the utterance preceded the request — a genuinely prior utterance in a real
 * meeting is seconds or minutes earlier, never tied to the millisecond.
 * Requiring strict `>` would manufacture false refusals for an immediate
 * reply without closing any real gap.
 *
 * `requestedAt` is `undefined` when the agent has never spoken — nothing
 * qualifies as an answer to a question that was never asked, so every
 * utterance is filtered out.
 *
 * Phrases that normalize to the empty string (misconfigured — an empty or
 * whitespace-only entry) are skipped rather than treated as a wildcard: an
 * empty needle is a substring of everything, which would turn a
 * misconfiguration into "anything anyone says authorizes the handoff".
 *
 * Newest-first, so the LATEST qualifying utterance wins if more than one
 * matches — the go-ahead is the most recent thing said, the same rule the
 * pre-consent buffer itself keeps (see `PRE_CONSENT_BUFFER_MAX`).
 *
 * An earlier grant does NOT survive a later refusal. A room that says "go
 * ahead" and is then contradicted by someone else has not reached consent —
 * so while scanning newest-first, an utterance that carries a negation token
 * ANYWHERE (whether or not it also matches a phrase — a bare "no, I've
 * changed my mind" matches no configured phrase at all, and must still
 * count) stops the scan outright rather than being skipped in favour of an
 * older match. This is deliberately scoped to the SAME qualifying window
 * `findConsentMatch` already restricts itself to — utterances at or after
 * `requestedAt` — which is the room actively responding to the specific
 * question the agent just asked, not an unbounded scan of the whole call.
 * An unrelated later utterance with no negation token in it at all ("can you
 * email me a copy afterward?") is silence on the question, not a refusal of
 * it, and does not disturb an earlier grant. This fails closed exactly as
 * the span rule above does: a room that must say "go ahead" once more after
 * a stray "no" is a nuisance; a refusal that an earlier grant papered over
 * is the failure this system exists to prevent. */
export function findConsentMatch<T extends HeardUtterance>(
  heard: readonly T[],
  requestedAt: string | undefined,
  phrases: readonly string[]
): { phrase: string; utterance: T } | undefined {
  if (requestedAt === undefined) return undefined;
  const needles = phrases
    .map((raw) => ({ raw, needle: normalizePhrase(raw) }))
    .filter((p) => p.needle !== "");
  if (needles.length === 0) return undefined;
  for (let i = heard.length - 1; i >= 0; i -= 1) {
    const utterance = heard[i];
    if (utterance.at < requestedAt) continue;
    const normalized = normalizePhrase(utterance.text);
    const hit = needles.find((n) => {
      const idx = normalized.indexOf(n.needle);
      return idx !== -1 && !hasNegationOutsideSpan(normalized, idx, idx + n.needle.length);
    });
    if (hit) return { phrase: hit.raw, utterance };
    // No un-negated phrase matched THIS utterance. If it carries a negation
    // token at all, it is a refusal (of a phrase, or of nothing named
    // in particular — "no" on its own is still a "no") and it overrides
    // every older utterance in the window: stop here rather than falling
    // through to an earlier "go ahead". An utterance with neither a phrase
    // match nor a negation token is simply unrelated to consent and is
    // skipped, same as before this fix.
    if (negationMatches(normalized).length > 0) return undefined;
  }
  return undefined;
}

/** Whether one utterance is an UNAMBIGUOUS refusal of the consent request —
 * the trigger for a denied meeting leaving the bridge rather than sitting on
 * it mute. Callers supply only utterances inside the consent window; this
 * judges the words.
 *
 * Deliberately NARROWER than "`findConsentMatch` refused it", and the gap is
 * the whole design. Consent fails closed one way: a negation anywhere outside
 * a matched phrase's span refuses the grant, so "oh no, sorry — go ahead"
 * takes no notes and the agent asks again. Leaving fails closed the OTHER
 * way, because a hangup is just as irreversible as a handoff and nobody can
 * recall it: it requires a negation token AND no accepted phrase anywhere in
 * the same breath. So that same sentence refuses consent and does not end the
 * meeting, which is the outcome a room saying it would want. A room that
 * plainly says "no", "please don't", or "I'd rather not" gets a goodbye and
 * an empty bridge.
 *
 * Uses the same normalization and the same word-boundary negation vocabulary
 * the gate does (`NEGATION_TOKENS`), so "refusal" means one thing in this
 * file and widening it widens both decisions together. The bound on that
 * vocabulary is real and worth stating: it is curated to shapes this codebase
 * has direct evidence for, so a refusal phrased outside it ("I'd rather
 * nothing was recorded") reads here as neither a grant nor a denial — no
 * notes, and the agent stays until the consent window times out. */
export function isConsentDenial(text: string, phrases: readonly string[]): boolean {
  const normalized = normalizePhrase(text);
  if (negationMatches(normalized).length === 0) return false;
  return !phrases.some((raw) => {
    const needle = normalizePhrase(raw);
    return needle !== "" && normalized.includes(needle);
  });
}

/** The ordering boundary a consent decision must be judged against: the one
 * that was in force when a go-ahead was FIRST heard, not the one in force
 * whenever `begin_notetaking` happens to arrive.
 *
 * Call this on every caller-side utterance, passing back the value it last
 * returned. It moves exactly once — from `undefined` to the `requestedAt` a
 * match was first seen against — and never again.
 *
 * It exists because on a live call the boundary outran the answer. The
 * boundary is the agent's most recent utterance, and the composed policy rail
 * (`meetingConsentRequest`, @parley/policy) requires the model to acknowledge
 * the go-ahead and call the tool in the SAME turn — so by the time the call is
 * routed, the acknowledgment is itself the most recent model utterance and the
 * go-ahead that prompted it sits BEFORE the boundary. `findConsentMatch` skips
 * it, and the gate refuses a phrase it would have accepted one instant
 * earlier. The room was told notes were being taken and none were.
 *
 * WHAT IS PINNED IS THE BOUNDARY, NEVER THE VERDICT, and that distinction is
 * the whole safety argument. Storing the match itself would be a latch that
 * never expires, which is precisely how the withdrawal defect
 * `findConsentMatch`'s newest-first walk was written to prevent comes back: a
 * room that says "go ahead" and then "actually, no" would have its earlier
 * grant replayed at tool-call time. Pinning only the boundary leaves that walk
 * running in full over the CURRENT buffer on every decision, so a later
 * negation still stops it, and a later go-ahead after that negation still
 * grants — the room can change its mind in both directions.
 *
 * Nor does this loosen the guard the boundary exists for. The anchor can only
 * ever be a `requestedAt` the agent actually reached — an utterance said
 * before the agent asked anything never sets it, because `findConsentMatch`
 * would not have matched then either. It widens the eligible window by exactly
 * the model speech that arrived AFTER the answer, which is the speech that
 * cannot have been what the room was answering. */
export function anchorConsentBoundary<T extends HeardUtterance>(
  anchored: string | undefined,
  heard: readonly T[],
  requestedAt: string | undefined,
  phrases: readonly string[]
): string | undefined {
  if (anchored !== undefined) return anchored;
  if (findConsentMatch(heard, requestedAt, phrases) === undefined) return undefined;
  return requestedAt;
}

/** Name of the environment variable that turns the consent debug dump below
 * on. Off unless it is set to something other than `""`, `"0"` or `"false"`.
 *
 * Read on every call rather than captured once at module load: a debug switch
 * that only works if it was set before the process started is a switch you
 * cannot use on the process that is already misbehaving. */
export const CONSENT_DEBUG_ENV_VAR = "PARLEY_DEBUG_CONSENT";

function consentDebugEnabled(): boolean {
  const raw = typeof process === "undefined" ? undefined : process.env?.[CONSENT_DEBUG_ENV_VAR];
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
}

/** EVERYTHING the consent gate saw, as one diagnostic line group.
 *
 * ⚠️ A DEBUGGING AID. IT MUST NOT BE ENABLED IN NORMAL OPERATION. Every other
 * diagnostic in this file is built so it CANNOT carry an accepted phrase or a
 * word anyone said — see `routeToolCall`'s `onDiagnostic` doc. This one
 * deliberately carries both, which is the opposite of the design's standing
 * promise: on a call whose consent is refused nothing said before the gate is
 * persisted at all (`consentReceipt: null`, and `CallSession.endCall` drops
 * the buffer), and this writes exactly that speech into a log. So it is
 * opt-in, off by default, and never a default path.
 *
 * What it exists to catch: a refusal whose cause cannot be read off the one
 * line a refusal normally leaves. The live failure this shipped with left
 * `heard=2 eligible=1 requested=true` and nothing else, and the cause — a
 * boundary that had moved past the go-ahead — was invisible in it, because
 * the go-ahead WAS counted as eligible against the boundary the line reported
 * and refused against a different one. The next such refusal should be
 * diagnosable from a log rather than from another live call.
 *
 * Each eligible utterance is annotated by the REAL rule, not a paraphrase of
 * it: `match` is `findConsentMatch` run over that utterance alone, `negation`
 * is the same token scan the newest-first walk stops on. Between them they
 * name which check rejected the utterance, and the walk's rule (newest first,
 * stop on a negation) says which utterance decided the call. */
function emitConsentDebugDump(params: {
  heard: readonly HeardUtterance[];
  requestedAt: string | undefined;
  phrases: readonly string[];
  modelTurnsCompleted: number;
  decision: ToolResult;
  emit?: (message: string) => void;
}): void {
  const { emit, requestedAt, phrases } = params;
  if (!emit || !consentDebugEnabled()) return;
  const eligible = params.heard.filter((u) => requestedAt !== undefined && u.at >= requestedAt);
  const lines = [
    `begin_notetaking ${CONSENT_DEBUG_ENV_VAR} dump — decision=${params.decision} ` +
      `boundary=${requestedAt ?? "none"} turnsCompleted=${params.modelTurnsCompleted} ` +
      `heard=${params.heard.length} eligible=${eligible.length}`,
    `  phrases=${JSON.stringify(phrases)}`,
    ...eligible.map((u) => {
      const match = findConsentMatch([u], requestedAt, phrases) !== undefined;
      const negation = negationMatches(normalizePhrase(u.text)).length > 0;
      return (
        `  heard speaker=${u.speaker ?? "unknown"} at=${u.at} match=${match} ` +
        `negation=${negation} text=${JSON.stringify(u.text)}`
      );
    })
  ];
  emit(lines.join("\n"));
}

/** Minimal carrier surface routeToolCall needs. Narrower than TelephonyProvider
 * on purpose, so the scenario harness can supply a recording mock without
 * implementing origination or webhooks. */
export interface ToolCarrier {
  sendDtmf(callId: string, digits: string): Promise<void>;
  endCall(reason: string): Promise<void>;
  /** Perform the plane handoff. Answered by CallSession; the harness supplies a
   * recording mock. */
  beginNotetaking(): Promise<void>;
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
  heard?: readonly HeardUtterance[];
  /** The timestamp of the agent's own most recent utterance before this call
   * was routed — see `ToolGate.authorizeNotetaking`'s doc for what it
   * bounds. `undefined` (the default) means nothing qualifies, matching
   * `heard`'s empty default: a caller that supplies neither gets the same
   * all-refusing gate a caller who supplies real evidence does not. */
  requestedAt?: string;
  modelTurnsCompleted?: number;
  /** Same seam `CallSession` already reports the handoff and the drain
   * through — see `CallSessionParams.onDiagnostic`. Before this, a refused
   * `begin_notetaking` answered the model and told nobody else: call
   * `CA0573ebc91a165c9c0230f8890915f87b` (2026-08-20) looped on refusal for
   * a minute — the operator experienced it as "connection issues" — and the
   * only surviving evidence was `modelTurnsCompleted: 7`, from which the
   * cause had to be guessed.
   *
   * Widened to EVERY call this function routes, not only a refused
   * `begin_notetaking`: two live calls in a row (2026-08-20) ended
   * `consent_refused` with `modelTurnsCompleted: 4` and nothing here at all,
   * because a model that never calls the tool never reaches the branch that
   * used to log. A model that never calls, one whose call is malformed, and
   * one whose call is accepted were indistinguishable on disk; only an
   * accepted-vs-refused diagnostic on every call makes the next silence
   * explain itself. Never carries the accepted phrases or any caller
   * utterance verbatim: this is written to disk, and the phrases are exactly
   * what an attacker reading that disk would want. Safe by construction, not
   * by care taken at each call site — see the wrapped `respond` below. */
  onDiagnostic?: (message: string) => void;
}): Promise<void> {
  const { call, gate, carrier, callId } = params;

  // One diagnostic line per call, whatever the outcome — wrapping the
  // response sink rather than logging at each `respond(...)` call site means
  // no branch, present or future, can forget to. `detail` is for the one tool
  // whose outcome needs more than the ToolResult itself to explain
  // (begin_notetaking, below); both `result` and `detail` are built only from
  // closed ToolResult literals and utterance COUNTS, never from `call.args`
  // or utterance text, so this can never carry what reaches this function on
  // the other end of a phone line.
  const respond = (result: ToolResult, detail?: string): void => {
    params.onDiagnostic?.(`${call.name} ${result}${detail ? ` — ${detail}` : ""}`);
    params.respond(result);
  };

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
      if (decision === "ok — say nothing more") {
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

    case "begin_notetaking": {
      const heard = params.heard ?? [];
      const decision = gate.authorizeNotetaking(
        heard,
        params.requestedAt,
        params.modelTurnsCompleted ?? 0
      );
      // Shape, not content: a count of what was in the pre-consent buffer and
      // whether any of it was even eligible (arrived at or after the request
      // `findConsentMatch` orders against) — never the utterance text or
      // which phrases would have matched it. Attached whether this call is
      // accepted or refused: an ACCEPTED call with `eligible=0` would itself
      // be a bug worth seeing on disk, and the two outcomes sharing one
      // detail format is what makes them comparable at all.
      const eligible =
        params.requestedAt === undefined
          ? 0
          : heard.filter((u) => u.at >= (params.requestedAt as string)).length;
      const detail = `heard=${heard.length} eligible=${eligible} requested=${params.requestedAt !== undefined}`;
      emitConsentDebugDump({
        heard,
        requestedAt: params.requestedAt,
        phrases: gate.consentPhrases,
        modelTurnsCompleted: params.modelTurnsCompleted ?? 0,
        decision,
        emit: params.onDiagnostic
      });
      if (decision !== "ok") {
        respond(decision, detail);
        return;
      }
      // Answer BEFORE the handoff. The handoff closes the realtime session, and a
      // tool response written to a closed session is a stalled turn, which on a
      // live call is dead air.
      respond("ok", detail);
      await carrier.beginNotetaking();
      return;
    }

    default:
      return respond("refused: tool not available");
  }
}

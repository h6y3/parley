import type { OpeningDelivery, OpeningDeliveryByShape } from "./types.js";

/** The single opening-trigger line sent once via `RealtimeSession.sendOpeningTrigger`
 * after connect. Plain, short, generic — never restates persona or brief
 * (design spec §4.1). This is Parley's ONLY fixed trigger string. Lives here
 * rather than in @parley/policy because it is generic, not policy. On a
 * provider declaring `openingDelivery: "prompt"` the same text is appended to
 * the system instruction instead — see `planOpening` below. */
/** Sent the moment the media stream attaches — which is BEFORE the far end has
 * made a sound.
 *
 * It used to read "Begin the call naturally now." On a call with no tools that
 * is harmless: the model greets, and a real callee talks over it or answers.
 * Give the same model a keypad and "begin now" becomes a keypress into silence.
 * Measured on the first live call: the callee heard a DTMF tone, no greeting,
 * and hung up.
 *
 * An outbound call is not the caller's to open anyway. The far end says
 * "hello", or a recording starts — the caller answers THAT. So the trigger now
 * says the one thing the model cannot observe for itself: nothing has been
 * heard yet. */
export const OPENING_TRIGGER =
  "The call has just connected and nothing has been heard from the other end yet. " +
  "Say NOTHING and press nothing until the other end has spoken. Waiting means silence: do not " +
  "announce that you are waiting, do not describe what you are doing, and do not narrate your own " +
  "state — anything you say here is heard aloud by whoever picks up. Listen for what answers: it " +
  "may be a person, or it may be a recording. Once you have actually heard which it is, respond to " +
  "what you heard — greet a person and say why you are calling; a recorded menu you work through " +
  "only after it has finished offering its options.";

/** The opening trigger for a call that JOINS A MEETING — chosen at the send
 * site (`CallSession.attach`) whenever `execution.meeting` is declared, in
 * place of `OPENING_TRIGGER`.
 *
 * `OPENING_TRIGGER` is written for a two-party call, and sent into a
 * conference bridge it deadlocks. Its opening half is right for both shapes:
 * at connect a bridge is hold music or silence, so "say NOTHING until the
 * other end has spoken" holds, and nothing afterwards ever revisits it. Its
 * only affirmative half is transactional — greet a person and say why you are
 * calling, or work a recorded menu — and neither describes joining a meeting,
 * so for a meeting the whole line resolves to "keep waiting". Measured on two
 * live meeting calls: `modelTurnsCompleted` 2 and 1, so the model took its
 * turns and chose to say nothing on both; no `begin_notetaking` was ever
 * called; both ended `consent_refused` with `coveredMs: 0` and no transcript.
 * The person on the far end heard the carrier's dial-in tones, then silence,
 * and hung up.
 *
 * Nothing in the instruction set contradicted that. The composed meeting rails
 * say "wait until you hear people talking to one another" and "you are a
 * notetaker, not a participant" — correct, and all of it pointing at silence.
 * What was missing was never another prohibition, it was the TRANSITION: no
 * line anywhere told the model that hearing the room is permission to speak
 * rather than one more reason to wait. So that moment is this trigger's whole
 * job, and it carries nothing the rails already carry — they hold WHAT to
 * announce (`meetingAnnounce`, with the principal and the purpose) and WHAT to
 * ask (`meetingConsentRequest`); this holds WHEN. It borrows the rails' own
 * boundary test, "talking to one another", verbatim, so the model is never
 * given two slightly different tests for the same moment.
 *
 * The consent question is asked positively — "whether it is all right" — never
 * "whether anyone objects". `meetingConsentRequest` carries a live-call
 * finding that a negative-polarity ask is granted with a bare "no", which is
 * the one answer the consent gate structurally cannot accept. A trigger that
 * reintroduced that polarity would fight the rail it hands over to.
 *
 * ⚠️ IT IS SENT BEFORE ANYTHING HAS BEEN HEARD, and on 2026-08-21 a live
 * scenario run announced itself straight into it — four times, once per turn,
 * to hold music. The affirmative half is the part a model acts on, and the
 * original wording put the prohibition and the permission in one breath with
 * the permission last. So the first clause now closes on the imperative ("say
 * nothing at all in reply to it") rather than on the observation, the
 * waiting-room sentence repeats it, and the release names what "people talking
 * to one another" excludes: two or more human voices, not a recorded message.
 *
 * Saying so was not enough on its own — a later run announced into the trigger
 * again — so it now also says what this message IS: not something to answer.
 * Every other input the model receives on this call is somebody speaking to the
 * room and warrants a decision about whether to reply; this one is the harness
 * of the call itself, and a model treating it like the others has already
 * spoken before anyone has said anything. The
 * same run also read the recorded hold message back to the room, which is why
 * that is refused here as well as in the composed rail — the trigger is the
 * only instruction in force during the seconds before the first rail is
 * relevant.
 *
 * Plain, short and generic like `OPENING_TRIGGER`: no persona, objective,
 * facts, or meeting brief (design spec §4.1). This is the only thing sent
 * after the system instruction, and `RealtimeSession` (`./types.ts`) exists to
 * guarantee it never becomes a re-instruction path. */
export const MEETING_OPENING_TRIGGER =
  "The call has just connected and nothing has been heard yet. This message is not something to " +
  "answer: say nothing at all in reply to it — anything you say goes out loud to everyone on " +
  "the call. Hold music, a recorded 'waiting for " +
  "the host' message, or silence all mean the meeting has not begun: say nothing, press " +
  "nothing, do not narrate that you are waiting, and do not read a recorded message back. When " +
  "you hear people talking to one another — two or more human voices, not a recorded message — " +
  "the waiting is over and you speak next: say once who you are and why you are here, then ask " +
  "whether it is all right for you to take notes.";

/** The opening on a `"prompt"`-delivery provider's MEETING — the one line
 * sent after connect there. `MEETING_OPENING_TRIGGER` itself rides in the
 * system instruction; this only marks the moment it describes, because a
 * bridge at connect is hold music or silence, and a model handed nothing at
 * all may never take a first turn in which to start listening for the room.
 *
 * A statement of fact, not an instruction: on such a vendor it arrives as a
 * USER turn, heard as someone on the line, so it asks for nothing and reads as
 * exactly what it is. One short line, no newline, no caller content. */
export const MEETING_CONNECTED_CUE = "The meeting line is connected.";

/** The opening on a `"prompt"`-delivery provider's TWO-PARTY call, sent at
 * most once and only if it turns out to be needed: the far end has spoken,
 * and the model has produced nothing at all within
 * `MISSED_GREETING_NUDGE_MS` (`./call-session.ts`) of the end of that speech.
 *
 * With the opening in the prompt the model waits for the far end's voice, and
 * nothing else ever starts the call. Twice live, a greeting the model did not
 * register — a callee who answered instantly, or a "hello" clipped to
 * fragments (one test call transcribed only "de Sesame") — left the agent
 * silent until the callee said hello again or the silence cap hung up.
 *
 * It is the meeting cue's two-party counterpart, and holds to the same rules:
 * a statement of fact, not an instruction, because on a user-turn vendor
 * (Deepgram's `InjectUserMessage`) it is heard as someone on the line. It
 * states exactly the condition `OPENING_TRIGGER` — already in the prompt —
 * waits for, "the other end has spoken", and nothing more: the opening
 * instruction stays the one in the prompt, delivered once, never restated.
 * One short line, no newline, no caller content, within the bound the
 * Deepgram provider enforces on this path. */
export const CALL_ANSWERED_CUE = "The other end has answered and spoken.";

/** What `planOpening` decided: text to append to the one-time system
 * instruction, the line to send as the opening, and — on a two-party call
 * opened in the prompt — the line `CallSession` sends once if the far end's
 * greeting was missed. Any may be absent. */
export interface OpeningPlan {
  promptSuffix?: string;
  trigger?: string;
  answeredCue?: string;
}

/** The one place the opening is decided — for `CallSession`, the scenario
 * runner and the audio runner alike. A harness choosing differently from
 * production would measure a call nobody makes.
 *
 * `"turn"` is the long-standing behaviour, byte for byte: the trigger for the
 * call's shape, sent as its own input. `"prompt"` moves that same text into
 * the system instruction and sends nothing on a two-party call (the callee's
 * "hello" is the opening — with `CALL_ANSWERED_CUE` held back in case that
 * "hello" is missed), or `MEETING_CONNECTED_CUE` on a meeting. See
 * `OpeningDelivery` (`./types.ts`) for why a vendor declares one or the
 * other, and `OpeningDeliveryByShape` for a vendor that declares each call
 * shape separately. Every string returned is a constant in this file. */
export function planOpening(
  declared: OpeningDelivery | OpeningDeliveryByShape,
  isMeeting: boolean
): OpeningPlan {
  // A per-shape declaration picks this call's delivery and is then planned
  // exactly as that plain value would be — so a provider declaring
  // `{ twoParty: "prompt", meeting: "turn" }` sends a meeting byte for byte
  // what a plain `"turn"` provider sends it.
  const delivery =
    typeof declared === "string" ? declared : isMeeting ? declared.meeting : declared.twoParty;
  const opening = isMeeting ? MEETING_OPENING_TRIGGER : OPENING_TRIGGER;
  if (delivery === "turn") return { trigger: opening };
  return isMeeting
    ? { promptSuffix: opening, trigger: MEETING_CONNECTED_CUE }
    : { promptSuffix: opening, answeredCue: CALL_ANSWERED_CUE };
}

/** The full system instruction a connect sends: the rendered brief, plus the
 * opening when `planOpening` put it in the prompt. The one place the two are
 * joined — for `CallSession`, the scenario runner and the audio runner alike —
 * so what a harness reports as "the prompt" is byte for byte what a real call
 * on the same provider sends. The suffix is a Parley constant (`planOpening`
 * returns nothing else), so the result is still rendered brief plus fixed
 * text. */
export function withOpening(rendered: string, opening: OpeningPlan): string {
  return opening.promptSuffix !== undefined ? `${rendered}\n\n${opening.promptSuffix}` : rendered;
}

/** The instant and the zone the model is told "today" in. `now` is a `Date`
 * so the caller's injected clock (`CallSessionParams.now`, the harness's
 * runner clock) is what decides the date, never a hidden `new Date()` here. */
export interface TodayInput {
  now: Date;
  /** An IANA zone name (`America/Los_Angeles`). Weekday and date are computed
   * in it, so a call placed at 23:30 local is not dated by UTC's tomorrow. */
  timeZone: string;
}

/** The host's own zone — the default when nothing configures one. */
export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `PARLEY_TIMEZONE`: the IANA zone the model is told today's date in.
 * Optional; unset means the host's zone. An invalid name is a boot error that
 * names only this variable — a bad zone otherwise surfaces on the first call
 * as a RangeError from inside the connect path. */
export function resolveTimeZone(env: NodeJS.ProcessEnv): string | undefined {
  const timeZone = env.PARLEY_TIMEZONE;
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
  } catch {
    throw new Error("PARLEY_TIMEZONE is not a valid IANA time zone name");
  }
  return timeZone;
}

/** `YYYY-MM-DD` for an instant in an IANA zone. Read by part type from an
 * `en-US` formatter rather than from a locale that happens to print ISO order
 * (`en-CA`), which is ICU data a trimmed Node build may not carry. */
export function isoDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The one sentence that lets the model turn "next Tuesday" into the ISO date
 * the outcome schema requires. A model has no clock; without this it guesses
 * the year from training data. Parley-authored and computed once at connect —
 * never caller content, so it does not widen the one-shot instruction. */
export function todaySentence(today: TodayInput): string {
  const date = isoDate(today.now, today.timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: today.timeZone,
    weekday: "long"
  }).format(today.now);
  return (
    `Today is ${weekday}, ${date} (${today.timeZone}). When the other person gives a relative ` +
    `date such as "tomorrow" or "next Tuesday", work out the calendar date from today before ` +
    `you record it. The next 14 days are: ${nextDays(today, 14).join(", ")}. ` +
    `When you say a date, use the weekday and date together exactly as listed.`
  );
}

/** The `count` calendar days after today in `today.timeZone`, as "Thu Oct 1"
 * (with the year, "Fri Jan 1 2027", for a day that falls in a later year than today).
 *
 * Told "Today is Wednesday, 2026-09-30", a think model on live calls resolved
 * "next Tuesday" to October 7th, twice (it is October 6). Weekday arithmetic is
 * what a language model does worst, so the sentence hands over the calendar
 * rather than asking for one to be computed.
 *
 * Today's date is read in the call's zone with `formatToParts`; the following
 * days are then stepped as UTC calendar dates at noon and formatted in UTC, so
 * a DST change in the call's zone can neither skip nor repeat a day. The locale
 * is pinned to `en-US` and every part is read by type, so the host's locale
 * never shapes the text. */
function nextDays(today: TodayInput, count: number): string[] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: today.timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(today.now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  const [year, month, day] = [part("year"), part("month"), part("day")];
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  const days: string[] = [];
  for (let i = 1; i <= count; i++) {
    const p = label.formatToParts(new Date(Date.UTC(year, month - 1, day + i, 12)));
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      p.find((x) => x.type === type)?.value ?? "";
    // The year is named only on days outside today's year: "Fri Jan 1 2027"
    // is unambiguous across a year boundary, and an ordinary list stays as
    // short as it was.
    const entryYear = get("year");
    days.push(
      `${get("weekday")} ${get("month")} ${get("day")}` +
        (Number(entryYear) === year ? "" : ` ${entryYear}`)
    );
  }
  return days;
}

export interface RenderInput {
  persona: string;
  objective: string;
  facts: readonly string[];
  guardrails: readonly string[];
  /** When present, one Parley-authored sentence stating today's date is
   * appended as the last section. Absent leaves the output byte-identical to
   * what it was before this field existed. */
  today?: TodayInput;
}

/** Policy-agnostic assembler. Orders persona, then objective+facts, then
 * guardrails, joining sections with a blank line. Knows nothing about modes,
 * disclosure, or deferral — the caller composes `guardrails` upstream
 * (@parley/policy). Empty sections are omitted so no trailing blank lines
 * appear. Parley's only prompt guarantee: this framing introduces no
 * structural markers of its own. */
export function renderSystemInstruction(input: RenderInput): string {
  const sections: string[] = [input.persona.trim()];
  const objectiveAndFacts = [input.objective.trim(), input.facts.join(" ")]
    .filter(Boolean)
    .join(" ");
  if (objectiveAndFacts) sections.push(objectiveAndFacts);
  const guardrails = input.guardrails.join(" ").trim();
  if (guardrails) sections.push(guardrails);
  if (input.today) sections.push(todaySentence(input.today));
  return sections.join("\n\n");
}

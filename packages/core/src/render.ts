/** The single opening-trigger line sent once via `RealtimeSession.sendOpeningTrigger`
 * after connect. Plain, short, generic — never restates persona or brief
 * (design spec §4.1). This is Parley's ONLY fixed trigger string. Lives here
 * rather than in @parley/policy because it is generic, not policy. */
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

export interface RenderInput {
  persona: string;
  objective: string;
  facts: readonly string[];
  guardrails: readonly string[];
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
  return sections.join("\n\n");
}

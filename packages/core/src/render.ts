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

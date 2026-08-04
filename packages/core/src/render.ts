/** The single opening-trigger line sent once via `RealtimeSession.sendOpeningTrigger`
 * after connect. Plain, short, generic — never restates persona or brief
 * (design spec §4.1). This is Parley's ONLY fixed trigger string. Lives here
 * rather than in @parley/policy because it is generic, not policy. */
export const OPENING_TRIGGER = "Begin the call naturally now.";

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
  const objectiveAndFacts = [input.objective.trim(), input.facts.join(" ")].filter(Boolean).join(" ");
  if (objectiveAndFacts) sections.push(objectiveAndFacts);
  const guardrails = input.guardrails.join(" ").trim();
  if (guardrails) sections.push(guardrails);
  return sections.join("\n\n");
}

import { OPENING_TRIGGER, renderSystemInstruction, type Brief } from "@parley/core";
import { composePolicy, type CallPolicy } from "@parley/policy";

export interface PayloadPreview {
  systemInstruction: string;
  openingTrigger: string;
}

/** Prints and returns EXACTLY what a given Brief + CallPolicy would send as
 * systemInstruction and opening trigger — the payload-preview harness feature
 * (design spec §10.2), so a reviewer can read and audit the literal call
 * payload before anything goes near a real call. No network calls. */
export function buildPayloadPreview(brief: Brief, policy: CallPolicy): PayloadPreview {
  const systemInstruction = renderSystemInstruction({
    persona: brief.persona,
    objective: brief.objective,
    facts: brief.facts,
    guardrails: composePolicy(policy)
  });
  return { systemInstruction, openingTrigger: OPENING_TRIGGER };
}

const RULE = "=".repeat(78);

export function formatPayloadPreview(preview: PayloadPreview): string {
  return [
    RULE,
    " PARLEY PAYLOAD PREVIEW — exact call-start payload, no network",
    RULE,
    "",
    `systemInstruction (${preview.systemInstruction.length} chars):`,
    preview.systemInstruction,
    "",
    `openingTrigger: "${preview.openingTrigger}"`,
    ""
  ].join("\n");
}

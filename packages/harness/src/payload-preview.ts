import {
  defaultTimeZone,
  planOpening,
  type TodayInput,
  renderSystemInstruction,
  type Brief,
  type MeetingExecution,
  withOpening
} from "@parley/core";
import { composePolicy, type CallPolicy } from "@parley/policy";

export interface PayloadPreview {
  systemInstruction: string;
  openingTrigger: string;
  /** `execution.meeting.brief`, when the envelope declared one — carried
   * straight into the preview for an operator to audit, NEVER folded into
   * `systemInstruction`: the model is never told any of this (see
   * `MeetingExecution.brief`, `@parley/core`, for why — it exists for a
   * downstream readout, not for the call itself). Absent both for a
   * non-meeting brief file and for a meeting whose caller supplied none. */
  meetingBrief?: MeetingExecution["brief"];
}

/** Prints and returns EXACTLY what a given Brief + CallPolicy would send as
 * systemInstruction and opening trigger — the payload-preview harness feature
 * (design spec §10.2), so a reviewer can read and audit the literal call
 * payload before anything goes near a real call. No network calls.
 *
 * `meetingBrief` is accepted only to be echoed back on the returned preview
 * object (see `PayloadPreview.meetingBrief`'s own doc) — it plays no part in
 * `systemInstruction`, so passing it cannot change what the model is told. */
export function buildPayloadPreview(
  brief: Brief,
  policy: CallPolicy,
  meetingBrief?: MeetingExecution["brief"],
  today: TodayInput = { now: new Date(), timeZone: defaultTimeZone() }
): PayloadPreview {
  const rendered = renderSystemInstruction({
    persona: brief.persona,
    objective: brief.objective,
    facts: brief.facts,
    guardrails: composePolicy(policy),
    // As on a real call: the preview must show the sentence the model gets.
    today
  });
  // The preview shows the "turn" shape — Gemini's, and the one the text
  // preview runs — planned and joined by the same helpers a real call uses.
  // On a "prompt" provider the same trigger text is appended to the
  // systemInstruction instead of being sent as a line (see `planOpening`).
  const opening = planOpening("turn", false);
  const systemInstruction = withOpening(rendered, opening);
  const openingTrigger = opening.trigger!;
  return {
    systemInstruction,
    openingTrigger,
    ...(meetingBrief ? { meetingBrief } : {})
  };
}

const RULE = "=".repeat(78);

export function formatPayloadPreview(preview: PayloadPreview): string {
  const lines = [
    RULE,
    " PARLEY PAYLOAD PREVIEW — exact call-start payload, no network",
    RULE,
    "",
    `systemInstruction (${preview.systemInstruction.length} chars):`,
    preview.systemInstruction,
    "",
    `openingTrigger: "${preview.openingTrigger}"`,
    ""
  ];
  // A meeting brief is audited SEPARATELY from the call payload above it,
  // never merged into systemInstruction's own text — the whole point of
  // carrying it on the preview object rather than composing it into the
  // rendered instruction is that an operator can see it without it having
  // touched what the model receives. Absent entirely (no extra lines, no
  // empty-string placeholders) when the envelope declared no meeting brief,
  // so the output is byte-identical to before this field existed.
  const mb = preview.meetingBrief;
  if (mb) {
    lines.push("meetingBrief (audit-only — never sent to the model):");
    if (mb.title !== undefined) lines.push(`  title: ${mb.title}`);
    if (mb.topic !== undefined) lines.push(`  topic: ${mb.topic}`);
    if (mb.role !== undefined) lines.push(`  role: ${mb.role}`);
    if (mb.track !== undefined) lines.push(`  track: ${mb.track.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

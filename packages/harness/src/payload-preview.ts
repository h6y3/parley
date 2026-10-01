import {
  planOpening,
  type TodayInput,
  renderSystemInstruction,
  type Brief,
  type MeetingExecution,
  type OpeningDelivery,
  type OpeningDeliveryByShape,
  withOpening
} from "@parley/core";
import { composePolicy, type CallPolicy } from "@parley/policy";
import { harnessTimeZone } from "./time-zone.js";

export interface PayloadPreview {
  systemInstruction: string;
  /** The line sent as its own input at connect; absent when the opening rides
   * in `systemInstruction` and nothing is sent (a "prompt" two-party call). */
  openingTrigger?: string;
  /** `execution.meeting.brief`, when the envelope declared one — carried
   * straight into the preview for an operator to audit, NEVER folded into
   * `systemInstruction`: the model is never told any of this (see
   * `MeetingExecution.brief`, `@parley/core`, for why — it exists for a
   * downstream readout, not for the call itself). Absent both for a
   * non-meeting brief file and for a meeting whose caller supplied none. */
  meetingBrief?: MeetingExecution["brief"];
}

/** Which call a preview stands for. Absent fields give the "turn" two-party
 * shape. */
export interface PreviewShape {
  openingDelivery?: OpeningDelivery | OpeningDeliveryByShape;
  isMeeting?: boolean;
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
  today: TodayInput = { now: new Date(), timeZone: harnessTimeZone() },
  shape: PreviewShape = {}
): PayloadPreview {
  const rendered = renderSystemInstruction({
    persona: brief.persona,
    objective: brief.objective,
    facts: brief.facts,
    guardrails: composePolicy(policy),
    // As on a real call: the preview must show the sentence the model gets.
    today
  });
  // Planned and joined by the same helpers a real call uses. The default is
  // the "turn" shape — what the text preview and the scenario runs feed on, as
  // they plan the opening themselves. A caller showing a real call passes that
  // provider's delivery and whether it is a meeting: a "prompt" two-party call
  // then carries the opening inside the systemInstruction and sends nothing at
  // connect (see `planOpening`).
  const opening = planOpening(shape.openingDelivery ?? "turn", shape.isMeeting ?? false);
  const systemInstruction = withOpening(rendered, opening);
  return {
    systemInstruction,
    ...(opening.trigger !== undefined ? { openingTrigger: opening.trigger } : {}),
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
    preview.openingTrigger !== undefined
      ? `openingTrigger: "${preview.openingTrigger}"`
      : "openingTrigger: (none — the opening is part of the systemInstruction)",
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

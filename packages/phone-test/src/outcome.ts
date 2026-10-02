import { isRolePlaceholder, isWhoConfirmedField } from "@parley/core";
import type { PhoneScenario } from "./scenario.js";

/** The slice of the server's `CompletedCallRecord` the checks read. */
export interface CompletedCallRecordLike {
  endedBy: string;
  outcome?: { status: string; fields: Record<string, string> };
  realtimeClose?: { code: number; reason: string };
}

/** First-person disclosure only, on word boundaries. "language model" and
 * "virtual assistant" count only when the speaker calls itself one. */
const SELF_DISCLOSURE: RegExp[] = [
  /\bi'?m an ai\b/,
  /\bi am an ai\b/,
  /\bas an ai\b/,
  /\b(?:i'?m|i am|as) (?:just )?an? (?:\w+ ){0,2}(?:language model|virtual assistant)\b/,
  /\bthis is a test\b/,
  /\bi'?m a bot\b/,
  /\bi am a bot\b/
];

/** A sentence that asks, not states: "are you an AI?" is not a disclosure. */
function isQuestion(sentence: string): boolean {
  return sentence.endsWith("?") || /^(?:are you|is this|do you)\b/.test(sentence);
}

function disclosesAI(line: string): boolean {
  const text = line.toLowerCase().replace(/[‘’]/g, "'");
  return text
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .some((sentence) => !isQuestion(sentence) && SELF_DISCLOSURE.some((re) => re.test(sentence)));
}

/** Checks one call against its scenario's expectation. Returns typed codes,
 * empty when the call is clean. */
export function checkOutcome(
  record: CompletedCallRecordLike,
  expect: PhoneScenario["expect"],
  calleeText?: string[]
): string[] {
  const codes: string[] = [];
  const outcome = record.outcome;
  if (!outcome) {
    codes.push("outcome-missing");
  } else {
    if (outcome.status !== expect.status) codes.push("outcome-status");
    const unsupported = Object.entries(expect.fields ?? {}).some(([name, forms]) => {
      const value = (outcome.fields[name] ?? "").toLowerCase();
      return !forms.some((f) => value.includes(f.toLowerCase()));
    });
    if (unsupported) codes.push("unsupported-outcome");
    // The record carries field names, not descriptions: the name decides.
    const placeholder = Object.entries(outcome.fields).some(
      ([name, value]) => isWhoConfirmedField({ name, description: "" }) && isRolePlaceholder(value)
    );
    if (placeholder) codes.push("placeholder-name");
    if (outcome.status === "completed" && record.endedBy !== "model") {
      codes.push("not-ended-by-model");
    }
  }
  if (record.realtimeClose) codes.push("voice-dropped");
  const disclosed = (calleeText ?? []).some(disclosesAI);
  if (disclosed) codes.push("persona-violation");
  return codes;
}

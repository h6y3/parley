/** Everything a call needs that is pure caller content. Behavior policy is
 * composed separately (see @parley/policy) and passed to CallSession as
 * `guardrails`. */
export interface Brief {
  /** E.164 phone number to call. */
  to: string;
  /** Who is calling, first person, one persona only. */
  persona: string;
  /** The single objective for this call, plain prose. */
  objective: string;
  /** Flat declarative statements baked in as facts the call can draw on. */
  facts: readonly string[];
}

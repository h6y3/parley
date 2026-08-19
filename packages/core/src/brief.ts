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
  /** Standing wishes the call may reason FROM when a question is not covered by
   * `facts`. Deliberately weaker than a fact: facts are asserted, preferences
   * are answered from. Without this, `deferralRule` turns every calibrating
   * question ("so you only wanted X?") into a bail. */
  preferences?: readonly string[];
}

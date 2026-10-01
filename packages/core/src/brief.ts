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
  /** Words the speech recognizer should expect — typically a name it would
   * otherwise mishear ("Nguyen" heard as "Newian"). A recognition hint for the
   * provider (`RealtimeConnectParams.keyterms`), never rendered into the
   * system instruction and never parsed out of prose: `Brief` has no
   * structured name fields, so the caller who knows the name supplies it.
   * Providers without a keyterm facility ignore it. */
  keyterms?: readonly string[];
  /** Caller-owned lineage for retries of one real-world task. This is
   * operational metadata: it is recorded and enforced by the server, never
   * rendered into the model's system instruction. */
  operation?: {
    id: string;
    attempt: number;
    maxAttempts: number;
  };
}

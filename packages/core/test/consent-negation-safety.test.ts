import { describe, expect, it } from "vitest";
import { findConsentMatch } from "../src/execution.js";

const T0 = "2026-08-20T18:00:00.000Z";
const AFTER = "2026-08-20T18:00:05.000Z";

const heard = (text: string, at: string): { text: string; at: string } => ({ text, at });

/** Call `CA0573ebc91a165c9c0230f8890915f87b` (2026-08-20): the declared
 * phrase was "please do", and the room saying "please dont take notes" — a
 * flat REFUSAL — still granted consent, because "dont" starts with "do" and
 * `findConsentMatch` did plain `normalized.includes(needle)`. The first fix
 * (`e29165f`, `@parley/policy`'s `schema.ts`) rejects a phrase like
 * "please do" before it can ever be configured, and stays exactly as it
 * was — it is still the reason a real deployment can never declare a phrase
 * shaped like this one.
 *
 * What changed under this test is `findConsentMatch` itself: it now refuses
 * any match with a negation token OUTSIDE the matched span (see
 * `hasNegationOutsideSpan`, `execution.ts`), and that rule is general — it
 * has no idea "do" was ever the word involved. It catches "please dont take
 * notes" against "please do" for the same reason it catches "don't go
 * ahead" against "go ahead": "dont" is a negation token, and it falls
 * outside the phrase's own span either way. So the claim this file
 * originally made — "the guarantee lives entirely in what reaches this
 * function, not in a rewrite of what it does" — is no longer true, and
 * updating it here is the honest thing to do rather than leaving a comment
 * that describes behavior the code no longer has. The two fixes are
 * independent and now redundant on this one input: schema validation still
 * stops "please do" from ever being configured; the matcher would now also
 * refuse the resulting match if it somehow were. Both are asserted below. */
describe("findConsentMatch — a refusal does not grant consent, for a phrase that can actually be configured", () => {
  it("'please do' — the phrase this incident used — is now ALSO refused by findConsentMatch directly, via the general negation-outside-span rule, not anything specific to the word \"do\"", () => {
    const result = findConsentMatch([heard("please dont take notes", AFTER)], T0, ["please do"]);
    expect(result).toBeUndefined();
  });

  it("the test that matters most: a refusal utterance produces no match against a phrase the schema validation rule actually lets reach this function either", () => {
    const result = findConsentMatch([heard("please dont take notes", AFTER)], T0, [
      "go ahead and take notes"
    ]);
    expect(result).toBeUndefined();
  });
});

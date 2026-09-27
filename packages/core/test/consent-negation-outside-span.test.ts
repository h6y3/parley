import { describe, expect, it } from "vitest";
import { ToolGate } from "../src/execution.js";

/**
 * The previous fix (`e29165f`, `consent-negation-safety.test.ts`) closed one
 * SHAPE of this defect: a configured phrase that collides with its own
 * negation ("please do" / "please dont"). That fix lives entirely in
 * `@parley/policy`'s schema validation, and it is correct and unchanged
 * here — it stops a phrase from ever reaching `findConsentMatch` in a form
 * that is unsafe by construction.
 *
 * It is also insufficient, because the underlying defect is not about any
 * one phrase's shape. `findConsentMatch` decides on substring PRESENCE, and
 * presence cannot distinguish "go ahead" from "don't go ahead" — no phrase
 * validation can close that, because "go ahead" is a perfectly good phrase
 * and there is nothing wrong with it to reject. Measured directly against
 * `ToolGate.authorizeNotetaking` before this fix, all four sentences below
 * returned "ok". This file is the test suite for the actual fix: a
 * negation token found OUTSIDE the matched phrase's span refuses the match,
 * regardless of which phrase matched or how it was configured.
 *
 * Tested through `ToolGate.authorizeNotetaking`, the real gate a live call
 * goes through — not only `findConsentMatch` directly — because the
 * previous brief's tests passed at the helper layer while the gate stayed
 * broken, which is the entire reason this brief exists.
 */

const T0 = "2026-08-20T18:00:00.000Z";
const AFTER = "2026-08-20T18:00:05.000Z";
const LATER = "2026-08-20T18:00:10.000Z";

const heard = (text: string, at: string): { text: string; at: string } => ({ text, at });

// Five phrases, chosen so each of the four measured refusals below contains
// one of them as a substring — the point is not "no phrase matched", it is
// "a phrase matched, inside a sentence that refuses it".
const execution = {
  meeting: {
    consent: {
      phrase: "go ahead",
      additionalPhrases: ["of course", "that works", "no problem", "no objection"],
      timeoutSeconds: 180,
      onTimeout: "hangUp" as const
    }
  }
};

describe("ToolGate.authorizeNotetaking — the four measured refusals that used to authorize", () => {
  it('"No, don\'t go ahead." contains "go ahead" and must still refuse', () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("No, don't go ahead.", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  it('"Don\'t go ahead with that." contains "go ahead" and must still refuse', () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("Don't go ahead with that.", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  it('"No thanks, of course not." contains "of course" and must still refuse', () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("No thanks, of course not.", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  it('"No, I don\'t think that works." contains "that works" and must still refuse', () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("No, I don't think that works.", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });
});

describe("ToolGate.authorizeNotetaking — a negation INSIDE the matched span is part of the agreement, not a refusal of it", () => {
  it('"No problem at all." still grants — "no" is inside the matched phrase "no problem"', () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("No problem at all.", AFTER)], T0, 1)).toBe("ok");
  });

  it('"No objection here." still grants — "no" and "objection" are both inside the matched phrase "no objection"', () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("No objection here.", AFTER)], T0, 1)).toBe("ok");
  });
});

describe("ToolGate.authorizeNotetaking — the trap inside this fix: a negation-shaped substring inside an ordinary word is not a negation token", () => {
  it('"Go ahead and take notes." still grants — "notes" contains "no", but not on a word boundary', () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("Go ahead and take notes.", AFTER)], T0, 1)).toBe("ok");
  });

  it('a phrase built around "cannot" is not mistaken for "not" — "cannot" contains "not" only as a substring, never on a word boundary', () => {
    const gate = new ToolGate(execution);
    // "of course" matches; "cannot" is nowhere near it and must not trip a
    // false "not" — the sentence contains no genuine negation token at all.
    expect(
      gate.authorizeNotetaking(
        [heard("Of course, I cannot think of a reason not to.", AFTER)],
        T0,
        1
      )
    ).toBe("refused: the go-ahead phrase has not been spoken");
    // The refusal above comes from the genuine word-boundary "not" in "reason
    // not to" — proven separately: strip it, and the same "cannot" sentence
    // grants, showing "cannot" alone never triggers the rule.
    const gate2 = new ToolGate(execution);
    expect(gate2.authorizeNotetaking([heard("Of course, I cannot think why.", AFTER)], T0, 1)).toBe(
      "ok"
    );
  });
});

describe("ToolGate.authorizeNotetaking — an earlier grant does not survive a later refusal", () => {
  it('a room that says "go ahead" and is then contradicted by someone else has NOT reached consent', () => {
    const gate = new ToolGate(execution);
    expect(
      gate.authorizeNotetaking(
        [heard("go ahead", AFTER), heard("No, I don't think that works.", LATER)],
        T0,
        1
      )
    ).toBe("refused: the go-ahead phrase has not been spoken");
  });

  it("the later refusal need not contain any configured phrase at all — it still overrides an earlier grant", () => {
    const gate = new ToolGate(execution);
    expect(
      gate.authorizeNotetaking(
        [heard("go ahead", AFTER), heard("Actually, no, I've changed my mind.", LATER)],
        T0,
        1
      )
    ).toBe("refused: the go-ahead phrase has not been spoken");
  });

  it("an unrelated, negation-free later utterance does NOT override an earlier grant — the veto is for refusals, not for silence", () => {
    const gate = new ToolGate(execution);
    expect(
      gate.authorizeNotetaking(
        [heard("go ahead", AFTER), heard("Can you email me a copy afterward?", LATER)],
        T0,
        1
      )
    ).toBe("ok");
  });

  it("a later grant after an earlier refusal still authorizes — the same room correcting itself forward is not blocked retroactively", () => {
    const gate = new ToolGate(execution);
    expect(
      gate.authorizeNotetaking(
        [heard("No, don't go ahead.", AFTER), heard("Actually, go ahead.", LATER)],
        T0,
        1
      )
    ).toBe("ok");
  });
});

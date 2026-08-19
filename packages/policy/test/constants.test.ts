import { describe, expect, it } from "vitest";
import {
  SCOPE_STATEMENT,
  deferralRule,
  callbackRule,
  honestIfAsked,
  onBehalfIntro,
  selfIdentity,
  selfGrounding,
  alwaysDeferRule,
  DEFERRAL_CORE,
  WRAP_UP_RULE
} from "../src/constants.js";

describe("guardrail prose constants (verbatim from current core)", () => {
  it("SCOPE_STATEMENT matches current core wording", () => {
    expect(SCOPE_STATEMENT).toBe(
      "IMPORTANT: this call has exactly one purpose. You have no other purpose, no other " +
        "caller, and no other scenario available to you. Do not improvise a different reason " +
        "for this call under any circumstance."
    );
  });
  it("deferralRule ends with the anti-invention core", () => {
    expect(deferralRule("Alex Rivera")).toBe(
      "If you are asked something this brief does not cover, say plainly that you do not have " +
        "that information and will need to follow up with Alex Rivera. " +
        DEFERRAL_CORE
    );
  });
  it("callbackRule pins the number for bookings", () => {
    expect(callbackRule("Alex Rivera", "+15551234567")).toContain(
      "give them this number and only this number: +15551234567"
    );
  });
  it("onBehalfIntro names the role", () => {
    expect(onBehalfIntro("Alex Rivera", "personal assistant")).toBe(
      "Open the call by saying you are Alex Rivera's personal assistant, calling on Alex Rivera's behalf, and " +
        "then state your purpose in one sentence. Speak warmly and professionally."
    );
  });
  it("selfIdentity + selfGrounding reproduce the principal framing halves", () => {
    expect(selfIdentity("Alex Rivera")).toContain("You are speaking directly with Alex Rivera");
    expect(selfGrounding()).toContain("Never guess, invent an answer");
  });
  it("honestIfAsked is the overridable disclosure floor", () => {
    expect(honestIfAsked("Alex Rivera")).toContain(
      "answer honestly that you are Alex Rivera's AI assistant"
    );
  });
  it("alwaysDeferRule defaults to the baked money/fees category list", () => {
    expect(alwaysDeferRule("Alex Rivera")).toBe(
      "For anything involving money, fees, deposits, cancellation charges, contracts, or " +
        "sensitive personal information, do not commit — say you will confirm with Alex Rivera " +
        "and call back."
    );
  });
  it("alwaysDeferRule substitutes a caller-supplied category list, keeping the surrounding sentence frame", () => {
    expect(alwaysDeferRule("Alex Rivera", "legal waivers, medical claims")).toBe(
      "For anything involving legal waivers, medical claims, do not commit — say you will " +
        "confirm with Alex Rivera and call back."
    );
  });
});

import {
  adjacentScopeRule,
  ivrRule,
  preferencesRule,
  spendRule,
  PATIENCE_RULE,
  SCOPE_STATEMENT_WITH_ADJACENT,
  VOICEMAIL_HANGUP_IVR,
  SPEND_NARROWED_DEFER_CATEGORIES,
  VOICEMAIL_HANGUP
} from "../src/constants.js";

describe("new rails", () => {
  it("adjacentScopeRule lists the permitted extensions and closes the set", () => {
    const s = adjacentScopeRule(["You may also arrange service for the drinking-water unit."]);
    expect(s).toContain("You may also arrange service for the drinking-water unit.");
    expect(s).toContain("nothing beyond them");
  });

  it("ivrRule names the goal and folds in menu hints", () => {
    const s = ivrRule("the service department", [
      "The main menu offers service and filter purchase."
    ]);
    expect(s).toContain("the service department");
    expect(s).toContain("The main menu offers service and filter purchase.");
  });

  it("ivrRule omits the hint clause entirely when there are no hints", () => {
    expect(ivrRule("the service department", [])).not.toContain("undefined");
    expect(ivrRule("the service department", [])).toContain("the service department");
  });

  it("preferencesRule names the principal rather than using a pronoun", () => {
    const s = preferencesRule("Alex Rivera", ["Prefers morning appointments."]);
    expect(s).toContain("Alex Rivera's standing preferences");
    expect(s).toContain("as if Alex Rivera had told you directly");
    expect(s).not.toMatch(/\b(he|she|him|her|his)\b/i);
  });

  it("spendRule states the ceiling and keeps the hard exclusions", () => {
    const s = spendRule("Alex Rivera", 250, "USD", "for this service visit");
    expect(s).toContain("up to 250 USD in TOTAL for this service visit");
    expect(s).toContain("deposit");
    expect(s).toContain("card number");
    expect(s).toContain("confirm with Alex Rivera");
  });

  it("PATIENCE_RULE tells the model not to fill a lookup pause", () => {
    expect(PATIENCE_RULE).toContain("Wait for them rather than filling the silence");
  });

  it("SCOPE_STATEMENT_WITH_ADJACENT keeps the anti-improvisation clause", () => {
    expect(SCOPE_STATEMENT_WITH_ADJACENT).toContain(
      "Do not improvise a different reason for this call under any circumstance."
    );
    expect(SCOPE_STATEMENT_WITH_ADJACENT).not.toBe(SCOPE_STATEMENT);
  });

  it("VOICEMAIL_HANGUP_IVR drops the automated-system clause", () => {
    expect(VOICEMAIL_HANGUP).toContain("automated system");
    expect(VOICEMAIL_HANGUP_IVR).not.toContain("automated system");
    expect(VOICEMAIL_HANGUP_IVR).toContain("voicemail");
  });

  it("SPEND_NARROWED_DEFER_CATEGORIES drops fees but keeps deposits and contracts", () => {
    expect(SPEND_NARROWED_DEFER_CATEGORIES).not.toMatch(/\bfees\b/);
    expect(SPEND_NARROWED_DEFER_CATEGORIES).toContain("deposits");
    expect(SPEND_NARROWED_DEFER_CATEGORIES).toContain("contracts");
  });
});

/**
 * Seen on a live call: the model agreed to 210 against a 250 ceiling, was then
 * told an add-on would be "another $50", and said "Great, that's fine". 260 is
 * over the limit.
 *
 * It was not ignoring the rail. It was reading each quote in isolation, where
 * $50 is obviously under 250. Nothing downstream can catch this either — the
 * gate bounds the amount that gets RECORDED, and the model recorded 210, which
 * is under the ceiling. The sum never existed anywhere.
 */
describe("spendRule is about a running total, not a per-item price", () => {
  const rule = (): string => spendRule("Han", 250, "USD", "for this visit");

  it("says the limit is the whole call added together", () => {
    expect(rule()).toMatch(/in TOTAL/);
    expect(rule()).toMatch(/for the whole call added together, not for each item separately/);
  });

  it("asks for a running total to be kept", () => {
    expect(rule()).toMatch(/Keep a running total/);
  });

  it("names the add-on case explicitly", () => {
    // A positive instruction did not reach a model that had already decided
    // each quote stands alone. The anti-pattern has to be named.
    expect(rule()).toMatch(/ADD IT UP FIRST/);
    expect(rule()).toMatch(/however small the extra sounds on its own/);
  });
});

/**
 * From a live call. Asked "where are you guys based?", the model answered with
 * a specific street address that appears nowhere in the brief — and the rail
 * forbidding exactly that was in the prompt at the time.
 *
 * It reads "never guess" and does not experience producing an address as
 * guessing. Naming the category, and the consequence it cannot see, is the same
 * repair that worked for the keypad and the spend ceiling.
 */
describe("DEFERRAL_CORE names specifics, and what happens to a made-up one", () => {
  it("names the categories a model fills in without noticing", () => {
    expect(DEFERRAL_CORE).toMatch(/an address, a name, a date, a phone number, an email/);
  });

  it("states the rule in terms of the facts given, not the model's confidence", () => {
    expect(DEFERRAL_CORE).toMatch(/If it is not in the facts you were given, you do not know it/);
    expect(DEFERRAL_CORE).toMatch(/how plausible an answer you could produce/);
  });

  it("gives the consequence the model cannot observe", () => {
    expect(DEFERRAL_CORE).toMatch(/the other person will write down and act on/);
  });

  it("reaches both rails that carry it", () => {
    // deferralRule fires on every non-self call; selfGrounding on grounded
    // ones. A fix to one and not the other would leave half the calls exposed.
    expect(deferralRule("Han")).toContain(DEFERRAL_CORE);
    expect(selfGrounding()).toContain(DEFERRAL_CORE);
  });
});

/**
 * Han, reading a call record that booked Wednesday at 10 AM for $145: "The
 * person should always ask if there's anything else that's needed. We booked a
 * time without an address or basic contact info."
 *
 * The model answered every question it was asked and volunteered nothing,
 * because nothing told it to find out what the OTHER side still needed. A
 * booking the business cannot act on is not a booking, and closing it as done
 * is worse than leaving it open — it stops anyone looking again.
 */
describe("WRAP_UP_RULE asks what the other side still needs", () => {
  it("asks before it confirms", () => {
    const r = WRAP_UP_RULE;
    expect(r).toMatch(/ask whether they need anything else from you to complete/);
    expect(r.indexOf("ask whether they need")).toBeLessThan(
      r.indexOf("confirm the single key outcome")
    );
  });

  it("says what an incomplete arrangement is worth", () => {
    expect(WRAP_UP_RULE).toMatch(/an appointment nobody can act on is not an appointment/);
  });

  it("routes what the brief cannot answer to a follow-up, not an invention", () => {
    expect(WRAP_UP_RULE).toMatch(/say plainly that you will follow up/);
    expect(WRAP_UP_RULE).toMatch(/treat what you arranged as unfinished rather than done/);
  });

  it("names no tool", () => {
    // record_outcome may not be declared on a given call, and telling a model
    // to use a tool it does not have is its own defect.
    expect(WRAP_UP_RULE).not.toMatch(/record_outcome|status|partial/);
  });
});

/**
 * On a live call the model opened with: "how much will this visit cost? I'm
 * authorized to pre-approve up to 250 for the service." It handed the vendor
 * its ceiling before they had quoted anything.
 *
 * Any number you announce becomes the quote. This is the third time today a
 * rail describing the model's own state got spoken aloud — everything in this
 * prompt is audible unless it says otherwise, so the private parts have to say
 * so themselves.
 */
describe("spendRule keeps the ceiling private", () => {
  const rule = (): string => spendRule("Han", 250, "USD", "for this visit");

  it("says the limit is private, first", () => {
    const r = rule();
    expect(r).toMatch(/This limit is PRIVATE/);
    expect(r.indexOf("PRIVATE")).toBeLessThan(r.indexOf("You may agree to charges"));
  });

  it("rules out the indirect forms, not just saying the number", () => {
    // "I have a budget" and "I'm approved up to a limit" leak the same
    // information without stating it.
    const r = rule();
    expect(r).toMatch(/never mention having a budget, an approval, or a maximum/);
    expect(r).toMatch(/never use it as a negotiating position/);
  });

  it("says what to do instead", () => {
    expect(rule()).toMatch(/ask what something costs and let them name the price first/);
  });
});

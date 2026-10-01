import { describe, expect, it } from "vitest";
import { composePolicy } from "../src/compose.js";
import type { CallPolicy } from "../src/schema.js";

const base = {
  principalName: "Jordan Rivera",
  identity: { style: "onBehalf" as const, role: "assistant" },
  disclosure: { honestIfAsked: true, volunteer: true },
  scope: { lock: true },
  grounding: { antiInvention: true },
  deferral: { enabled: true },
  authority: {}
};

const withMeeting = { ...base, meeting: { announce: true } };

describe("meeting guardrails", () => {
  it("tells the model to wait out a waiting room before announcing", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).toMatch(/hold music|waiting/i);
    expect(rails).toMatch(/do not (speak|announce)/i);
  });

  it("states the agent is a notetaker, not a participant", () => {
    expect(composePolicy(withMeeting).join("\n")).toMatch(
      /not a participant|do not join the discussion/i
    );
  });

  it("names the consent phrase as the thing it must wait to hear", () => {
    expect(composePolicy(withMeeting).join("\n")).toMatch(/begin_notetaking/);
  });

  it("tells the model to say goodbye on a refusal, and that it need do nothing to end the call", () => {
    const rails = composePolicy(withMeeting).join("\n");
    // Condition-first since 2026-08-21: a live run spoke this rail's goodbye
    // to a room that had just granted consent, because the condition sat
    // mid-sentence and the rail read as a standing instruction. Assert the
    // condition LEADS, and that the rail names its own inapplicability.
    expect(rails).toMatch(/^only if a person in the meeting tells you not to take notes/im);
    expect(rails).toMatch(/if nobody has told you that, never say any of this/i);
    // The condition must exclude the thing the model actually mistook for it:
    // three live runs read a refused begin_notetaking as the room declining.
    expect(rails).toMatch(/refused is not somebody declining/i);
    expect(rails).toMatch(/do not ask again/i);
    expect(rails).toMatch(/the call ends by itself/i);
    // Naming a tool a meeting envelope need not declare is the failure shape
    // this rail's own doc warns about — the leaving is the server's job.
    expect(rails).not.toMatch(/end_call/);
    // Same standing rule as the consent request: never say a phrase that
    // would count as consent, in the ask OR in the goodbye.
    expect(rails).not.toMatch(/go ahead/i);
  });

  it("emits no meeting rails when policy.meeting is absent", () => {
    const rails = composePolicy(base).join("\n");
    expect(rails).not.toMatch(/begin_notetaking/);
    expect(rails).not.toMatch(/notetaker/i);
  });
});

/**
 * Every optional field populated to the value that would fire its rail on a
 * "call"-shape policy — the same idea as schema-rail-coverage.test.ts's
 * `full` fixture, built independently here so this file's suppression claims
 * don't depend on reading that one. `composePolicy` takes a plain `CallPolicy`
 * object with no schema validation in between, so this fixture can legally
 * combine `meeting` with fields the envelope schema now REJECTS together
 * (`callback`, `wrapUp`, `voicemail`, `authority.spend`,
 * `authority.authorizedCommitments` — see schema.ts's meeting rejections) —
 * which is exactly the point: composePolicy's own suppression, not merely the
 * schema rejection upstream of it, is what this rail-set selection is.
 */
const fullMeetingPolicy: CallPolicy = {
  principalName: "Jordan Rivera",
  identity: { style: "onBehalf" as const, role: "assistant" },
  disclosure: { honestIfAsked: true, volunteer: true },
  scope: { lock: true, adjacent: ["Also note down action items."] },
  grounding: { antiInvention: true },
  deferral: { enabled: true },
  authority: {
    authorizedCommitments: ["Confirm the roadmap date."],
    alwaysDefer: ["Legal commitments."],
    spend: { limit: 250, currency: "USD", basis: "for this visit" }
  },
  callback: { number: "+15555550142" },
  wrapUp: { enabled: true },
  voicemail: { onMachine: "leaveMessage" as const },
  patience: { expectLookupPauses: true },
  pronunciation: ["Pronounce the last name Rivera as ree-VAIR-uh."],
  extraGuardrails: ["Custom deployment note."],
  meeting: { announce: true, purpose: "take notes for the roadmap sync" }
};

/**
 * Root cause of this task: rails were selected by POLICY FIELD, not by call
 * shape, so a meeting envelope composed 14 rails, 6 of which presuppose a
 * two-party call the agent steers, negotiates, and closes — behavior a
 * structurally-voiceless notetaker can never perform. This block proves the
 * composed rail SET directly: exactly what the design brief's "compose only"
 * list says (the meeting rails, honest-if-asked, pronunciation,
 * extraGuardrails) and nothing from the "everything else is suppressed" list,
 * even though every one of those fields is populated in `fullMeetingPolicy`
 * above and would fire if the composer still selected by field.
 */
describe("a meeting composes only its own rail set", () => {
  const rails = composePolicy(fullMeetingPolicy).join("\n");

  it("keeps the five meeting rails", () => {
    expect(rails).toMatch(/waiting room/i);
    expect(rails).toMatch(/AI assistant on the line/i);
    expect(rails).toMatch(/is all right if you take notes/i);
    expect(rails).toMatch(/that you are leaving now/i);
    expect(rails).toMatch(/notetaker, not a participant/i);
  });

  it("keeps honest-if-asked, adapted for a meeting", () => {
    expect(rails).toMatch(/answer honestly that you are/i);
    // The call-shape wording this replaces — see honestIfAskedMeeting's doc
    // comment for why it cannot survive into a meeting context.
    expect(rails).not.toMatch(/continue the call naturally/i);
  });

  it("keeps pronunciation and extraGuardrails", () => {
    expect(rails).toContain("Pronounce the last name Rivera as ree-VAIR-uh.");
    expect(rails).toContain("Custom deployment note.");
  });

  it("does not compose the opening/identity rule", () => {
    expect(rails).not.toMatch(/open the call by saying/i);
  });

  it("does not compose the disclosure-volunteer rule", () => {
    expect(rails).not.toMatch(/near the start of the call, state plainly/i);
  });

  it("does not compose scope lock or redirect", () => {
    // Matches both SCOPE_STATEMENT ("...has exactly one purpose...") and its
    // adjacency variant ("...has one purpose, plus...") — fullMeetingPolicy
    // sets scope.adjacent, which swaps in the latter on a call-shape policy.
    expect(rails).not.toMatch(/no other scenario available to you/i);
    expect(rails).not.toMatch(/gently return the/i);
  });

  it("does not compose grounding, deferral, or always-defer", () => {
    expect(rails).not.toMatch(/answer only from what you actually know/i);
    expect(rails).not.toMatch(/then ask whether they can still go ahead/i);
    expect(rails).not.toMatch(/do not commit — say you will confirm/i);
  });

  it("does not compose spend or authorized commitments", () => {
    expect(rails).not.toMatch(/this limit is private/i);
    expect(rails).not.toMatch(/you may confirm or commit to the following/i);
  });

  it("does not compose callback, wrap-up, voicemail, or patience", () => {
    expect(rails).not.toMatch(/give them this number and only this number/i);
    expect(rails).not.toMatch(/when the purpose is settled, check once whether/i);
    expect(rails).not.toMatch(/if you reach a voicemail/i);
    expect(rails).not.toMatch(/may go quiet while they look something up/i);
  });

  it("does not compose the IVR rail even though policy.ivr-shaped guidance would otherwise apply", () => {
    // fullMeetingPolicy carries no policy.ivr — a meeting call has no menu to
    // navigate — so this also guards against a future fixture edit adding one
    // by accident and this test going silently green for the wrong reason.
    expect(rails).not.toMatch(/automated menu may answer/i);
  });

  /** The specific contradiction that caused this task: a live envelope's
   * composed output told the model, in the same prompt, to wait in total
   * silence AND to open the call by speaking. The operator's report of what
   * that produced: "a bunch of random talking when the agent joins." Assert
   * on the pair directly, not on either half alone — this is the regression
   * this task exists to prevent. */
  it("never contains both 'wait in silence' and 'open the call by speaking'", () => {
    expect(rails).toMatch(/do not speak, do not announce yourself/i);
    expect(rails).not.toMatch(/open the call by saying/i);
    expect(rails).not.toMatch(/near the start of the call, state plainly/i);
  });
});

/**
 * The scoping proof: build the same fully-populated fields WITHOUT a meeting
 * and confirm every rail the meeting test above asserts absent is present
 * here instead — the suppression is a property of the meeting shape, not a
 * change to what any of these fields do on an ordinary call.
 * `golden-equivalence.test.ts` pins three real presets byte-for-byte; this
 * checks the same invariant at the field-presence level, using the identical
 * fixture the meeting test uses (minus `meeting`) so the "it's the shape, not
 * the field" claim is directly comparable rather than argued from two
 * different fixtures.
 */
describe("the same fields, without a meeting, compose exactly what they compose today", () => {
  const nonMeetingPolicy: Partial<CallPolicy> = { ...fullMeetingPolicy };
  delete nonMeetingPolicy.meeting;
  const rails = composePolicy(nonMeetingPolicy as CallPolicy).join("\n");

  it("composes the opening/identity rule, disclosure-volunteer, and scope lock", () => {
    expect(rails).toMatch(/open the call by saying/i);
    expect(rails).toMatch(/near the start of the call, state plainly/i);
    // Matches both SCOPE_STATEMENT and its adjacency variant — see the note
    // on the mirrored assertion in the meeting describe block above.
    expect(rails).toMatch(/no other scenario available to you/i);
  });

  it("composes deferral, always-defer, spend, and authorized commitments", () => {
    expect(rails).toMatch(/then ask whether they can still go ahead/i);
    expect(rails).toMatch(/this limit is private/i);
    expect(rails).toMatch(/you may confirm or commit to the following/i);
  });

  it("composes callback, wrap-up, voicemail, and patience", () => {
    expect(rails).toMatch(/give them this number and only this number/i);
    expect(rails).toMatch(/when the purpose is settled, check once whether/i);
    expect(rails).toMatch(/if you reach a voicemail/i);
    expect(rails).toMatch(/may go quiet while they look something up/i);
  });

  it("composes honest-if-asked with the call-shape wording, not the meeting one", () => {
    expect(rails).toMatch(/continue the call naturally/i);
  });

  it("carries no meeting rail at all", () => {
    expect(rails).not.toMatch(/waiting room/i);
    expect(rails).not.toMatch(/notetaker, not a participant/i);
  });
});

/** The one purpose field, proven from the composed prose rather than from the
 * schema: what the room hears comes from `policy.meeting.purpose`, and nothing
 * in the execution plane can contradict it. */
describe("the spoken purpose", () => {
  it("comes from policy.meeting.purpose", () => {
    const rails = composePolicy({
      ...base,
      meeting: { announce: true, purpose: "take notes for the roadmap sync" }
    });
    expect(rails.join("\n")).toContain("to take notes for the roadmap sync");
  });

  it("falls back to a stated default when no purpose is declared, and says so out loud", () => {
    const rails = composePolicy(withMeeting);
    expect(rails.join("\n")).toContain("to take notes");
  });
});

/** Call CA7c430ad3a031719e8f98b297628b5b37's transcript has the model
 * saying "Does anyone object to my taking notes? Please say the phrase,
 * 'Go ahead,' to give me the go-ahead." — reciting a passphrase the very
 * next clause forbade it from saying. `meetingConsentRequest` takes no
 * arguments and never has, so there was never a real phrase for it to
 * solicit; asked to elicit a specific reply and never to say that reply
 * itself, inventing and speaking one anyway was the only response with no
 * contradiction. Fixed by asking an ordinary, open question instead of
 * naming anything at all — the gate (`findConsentMatch`) matches on
 * ORDERING, not on exact wording (see consent-ordering.test.ts), so no
 * shared password is needed for consent to be granted. */
describe("the consent request", () => {
  it("asks an open, ordinary question rather than soliciting a specific reply", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).toMatch(/ordinary.{0,15}question/i);
    expect(rails).not.toMatch(/say the .{0,30}phrase/i);
  });

  it("forbids naming or hinting at any phrase when asking, not only when acknowledging", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).toMatch(/never say, quote, spell out or hint at any wording/i);
    expect(rails).toMatch(/not when you ask, and not when you acknowledge/i);
  });

  // Call `CA0573ebc91a165c9c0230f8890915f87b` (2026-08-20): told to ask
  // "whether anyone objects", the model complied literally and asked a
  // negative-polarity question whose natural affirmative answer is a bare
  // "no" — refused by the two-word floor on its own, and catastrophic under
  // substring matching regardless ("no" sits inside "notes"/"know"/"now").
  // The question must now be positive-polarity: its natural agreement is an
  // affirmative word, not "no".
  it("asks a positive-polarity question, not whether anyone objects", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).not.toMatch(/objects? to/i);
    expect(rails).toMatch(/all right/i);
  });
});

/** Call CAa717b30c25f88b2d1b0966da77940a6b: consent granted, then total
 * silence, and the persisted record showed the begin_notetaking turn DID
 * complete — the model spoke no acknowledgment because nothing told it to.
 * Fixed by telling the model to acknowledge before going quiet — the fourth
 * defect below is what that fix's own wording then caused. */
describe("the consent acknowledgment", () => {
  it("puts the acknowledgment ahead of the begin_notetaking call in the same instruction", () => {
    const rails = composePolicy(withMeeting).join("\n");
    const ackIndex = rails.search(/must acknowledge it/i);
    expect(ackIndex).toBeGreaterThan(-1);
    expect(rails.indexOf("begin_notetaking", ackIndex)).toBeGreaterThan(ackIndex);
  });
});

/** A fourth defect, found afterward on a later pair of live calls (not the
 * incident above): both ended `consent_refused` with
 * `modelTurnsCompleted: 4`, the operator confirmed by ear the agent heard
 * the go-ahead and said "thank you", and `begin_notetaking` was never
 * called at all. The fix above worded the ordering as "THEN call
 * begin_notetaking — in that order: calling the tool ends your turn
 * immediately, so anything you meant to say has nowhere to go" — read next
 * to the tool description's own "ends your ability to speak for the rest of
 * the meeting", that is the same warning twice and no instruction to
 * actually act, and "acknowledge, THEN call" names two sequential steps a
 * turn can complete between. */
describe("the consent acknowledgment and call, bound into one required step", () => {
  it("states the call as required, not a hazard to weigh", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).toMatch(/must acknowledge it and call begin_notetaking/i);
  });

  it("binds them into the SAME turn rather than a sequenced 'then'", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).toMatch(/same turn/i);
    expect(rails).not.toMatch(/then call begin_notetaking/i);
  });

  it("states plainly that acknowledging without calling is a failure, with a recovery instruction", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).toMatch(/without calling the tool is a failure/i);
    expect(rails).toMatch(/already acknowledged.{0,40}call it now/i);
  });

  // The property this whole defect turned on: the SAME two sentences that
  // used to co-occur ("ends your turn"/"nowhere to go") must not reappear —
  // that warning now lives exactly once, in the tool description
  // (`packages/core/src/execution.ts`), not in these rails at all.
  it("no longer carries the turn-ending rationale", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).not.toMatch(/ends your turn/i);
    expect(rails).not.toMatch(/nowhere to go/i);
  });

  // The duplicate "do not call before asking" / server-refusal framing is
  // dropped from the instruction too — it stays exactly once, in the tool
  // description, per the same brief.
  it("no longer carries the duplicate 'do not call before asking' framing", () => {
    const rails = composePolicy(withMeeting).join("\n");
    expect(rails).not.toMatch(/do not call it before you have asked/i);
    expect(rails).not.toMatch(/the server checks/i);
  });
});

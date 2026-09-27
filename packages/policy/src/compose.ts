import type { CallPolicy } from "./schema.js";
import {
  SCOPE_STATEMENT,
  REDIRECT_LANGUAGE,
  DEFERRAL_CORE,
  WRAP_UP_RULE,
  VOICEMAIL_HANGUP,
  deferralRule,
  authorityRule,
  alwaysDeferRule,
  callbackRule,
  honestIfAsked,
  honestIfAskedMeeting,
  volunteerDisclosure,
  onBehalfIntro,
  silentIntro,
  selfIdentity,
  selfTopicSwitch,
  selfGrounding,
  voicemailLeaveMessage,
  adjacentScopeRule,
  ivrRule,
  preferencesRule,
  spendRule,
  PATIENCE_RULE,
  SCOPE_STATEMENT_WITH_ADJACENT,
  VOICEMAIL_HANGUP_IVR,
  SPEND_NARROWED_DEFER_CATEGORIES,
  meetingWaitingRoom,
  meetingAnnounce,
  meetingConsentRequest,
  meetingConsentDeclined,
  meetingNotetakerScope
} from "./constants.js";

/** Preset catalog identifiers — used by the harness disclosure evaluator. Not a
 * core type; the three modes exist only as preset names in this package. */
export type CallMode = "principal" | "represented" | "transactional";

/**
 * The two shapes a composed call can be. Everything this package composed
 * before 2026-08-20 was implicitly "call" — a two-party outbound call with a
 * goal, a counterparty, and a goodbye. `meeting` is structurally different: it
 * dials into a bridge, waits, announces once, asks once for consent, and —
 * the instant consent is granted — becomes permanently unable to speak for
 * the rest of the call (`TranscriptionSession`, @parley/core, has no outbound
 * method; that is a hardware fact about the listening plane, not a policy
 * choice). Most of the "call" rail surface does not merely not apply to that
 * shape, it actively contradicts it — see the rail-set selection below.
 */
type CallShape = "call" | "meeting";

/** A rail: its fixed emission order, the call shape(s) it belongs to, and a
 * pure compose fn. Adding a behavior = add one entry here + a test. The
 * composer names no rail individually.
 *
 * `shapes` is deliberately mandatory and explicit on every entry, not a
 * default that only "meeting" opts out of: rails were selected purely by
 * POLICY FIELD until 2026-08-20, and a meeting envelope cannot decline the
 * schema-required fields (`identity`, `disclosure`, `scope`, `grounding`,
 * `deferral`) — so a real meeting call composed 14 rails, 6 of which told a
 * structurally-silent notetaker to open the call by speaking, negotiate a
 * price, or say goodbye. Rail 2 said wait in silence; rails 6 and 8 said
 * start talking on connect — verbatim from a live envelope, and the
 * operator's report of the call it produced: "a bunch of random talking when
 * the agent joins". Making `shapes` a required field forces every rail,
 * present and future, to state which shape(s) it is safe for, rather than
 * composing into a shape nobody checked it against. See
 * `.superpowers/sdd/2026-08-19-live-meeting-proxy-a1-parley/task-meeting-rails-brief.md`
 * for the full defect writeup. */
interface Rail {
  order: number;
  shapes: readonly CallShape[];
  /** `preferences` comes from the Brief, not the policy — it is caller CONTENT,
   * not behavior — but its rail must interleave with policy rails at order 45,
   * before deferral. Threading it as a second argument keeps composePolicy pure
   * and keeps Brief free of policy concerns. */
  compose(p: CallPolicy, preferences: readonly string[]): string[];
}

const RAILS: readonly Rail[] = [
  // The scope statement swaps to its adjacency variant when adjacencies exist:
  // "no other scenario available to you" contradicts a declared extension.
  // Meaningless once notetaking begins — there is no "subject" to lock, only
  // silence — and before that, the agent has no scope to defend: it has said
  // one sentence and asked one question, nothing to redirect away from yet.
  {
    order: 10,
    shapes: ["call"],
    compose: (p) =>
      p.scope.lock
        ? [(p.scope.adjacent?.length ?? 0) > 0 ? SCOPE_STATEMENT_WITH_ADJACENT : SCOPE_STATEMENT]
        : []
  },
  { order: 11, shapes: ["call"], compose: (p) => (p.scope.lock ? [REDIRECT_LANGUAGE] : []) },
  {
    order: 12,
    shapes: ["call"],
    compose: (p) =>
      (p.scope.adjacent?.length ?? 0) > 0 ? [adjacentScopeRule(p.scope.adjacent ?? [])] : []
  },
  // IVR is a two-party-call concept — working a phone tree to reach a person —
  // with no meeting equivalent, so it is call-shape only. At order 15 a
  // meeting composes ONLY the five meeting rails just below (never both: a
  // policy is one shape or the other, see composePolicy's shape selection).
  {
    order: 15,
    shapes: ["call"],
    compose: (p) => (p.ivr ? [ivrRule(p.ivr.goal, p.ivr.menuHints ?? [])] : [])
  },
  {
    order: 15,
    shapes: ["meeting"],
    // ORDER IS LOAD-BEARING, and `meetingConsentDeclined` moved to the end on
    // 2026-08-21. It used to sit between the consent request and the notetaker
    // scope, which put "say you are leaving" directly after "say you are going
    // quiet" — and a live run spoke both, to a room that had just said yes.
    // The granted path now reads contiguously (wait, announce, ask, go quiet)
    // and the refusal is the exception at the end, where its own condition can
    // lead. See `meetingConsentDeclined`'s doc comment.
    compose: (p) =>
      p.meeting?.announce
        ? [
            meetingWaitingRoom(),
            meetingAnnounce(p.principalName, p.meeting.purpose ?? "take notes"),
            meetingConsentRequest(),
            meetingNotetakerScope(),
            meetingConsentDeclined()
          ]
        : []
  },
  // Opens the call by speaking on connect — the exact instruction a live
  // meeting envelope carried alongside "wait in silence until people are
  // talking" (rail 2 above). Call-shape only: a meeting has its own, single
  // announcement inside the order-15 meeting rail, timed to the room actually
  // being under way rather than to the connection existing.
  {
    order: 20,
    shapes: ["call"],
    compose: (p) => {
      switch (p.identity.style) {
        case "self":
          return [selfIdentity(p.principalName)];
        case "onBehalf":
          return [onBehalfIntro(p.principalName, p.identity.role)];
        case "silent":
          return [silentIntro(p.principalName, p.identity.recipientName)];
      }
    }
  },
  {
    order: 25,
    shapes: ["call"],
    compose: (p) => (p.scope.lock === false ? [selfTopicSwitch()] : [])
  },
  // Honest-if-asked is the one disclosure rail kept for a meeting: California
  // is all-party-consent with an AI-disclosure expectation, and a participant
  // may ask "is that a bot?" in the waiting room or right after the
  // announcement, while the agent is still on the speaking plane and can
  // still answer. Two entries, same order, never both composed for the same
  // policy (shape selection is exclusive) — the meeting variant swaps out
  // "continue the call naturally", which presumes a two-party conversation
  // this agent never has. See `honestIfAskedMeeting`'s doc comment.
  {
    order: 30,
    shapes: ["call"],
    compose: (p) => (p.disclosure.honestIfAsked ? [honestIfAsked(p.principalName)] : [])
  },
  {
    order: 30,
    shapes: ["meeting"],
    compose: (p) => (p.disclosure.honestIfAsked ? [honestIfAskedMeeting(p.principalName)] : [])
  },
  // Proactive disclosure at the top of the call — meaningless for a meeting,
  // which has its own, single announcement (the order-15 meeting rail) timed
  // to when the room is actually under way, not to connection time.
  {
    order: 31,
    shapes: ["call"],
    compose: (p) => (p.disclosure.volunteer ? [volunteerDisclosure(p.principalName)] : [])
  },
  // Answering from what the agent knows presupposes the agent answers
  // questions at all. A meeting notetaker never does, before or after
  // consent — see meetingNotetakerScope.
  {
    order: 40,
    shapes: ["call"],
    compose: (p) => (p.grounding.antiInvention ? [selfGrounding()] : [])
  },
  // Before deferral at 50, deliberately — deferral must read as the fallback for
  // everything the preferences do not cover, not the other way round.
  // Directs the agent to ANSWER questions from standing preferences — the same
  // active-participant behavior the meeting notetaker rail forbids outright.
  {
    order: 45,
    shapes: ["call"],
    compose: (p, preferences) =>
      preferences.length > 0 ? [preferencesRule(p.principalName, preferences)] : []
  },
  // Deferral, always-defer, spend, and authorized commitments (50/55/56/60)
  // are all instructions for negotiating or committing on the principal's
  // behalf — the one thing a notetaker structurally cannot do, silent by
  // design for the entire meeting once consent is granted, and before that
  // scoped to one announcement and one question. Call-shape only.
  {
    order: 50,
    shapes: ["call"],
    compose: (p) => (p.deferral.enabled ? [deferralRule(p.principalName)] : [])
  },
  {
    order: 55,
    shapes: ["call"],
    compose: (p) => {
      // always-defer applies to any non-self call; the "self" identity (calling
      // the principal himself) has no third party to defer to.
      if (p.identity.style === "self") return [];
      const overrides = p.authority.alwaysDefer ?? [];
      // A caller-supplied category list REPLACES the baked default (money,
      // fees, ...) inside the same sentence frame, rather than appending to it.
      if (overrides.length > 0) return [alwaysDeferRule(p.principalName, overrides.join(", "))];
      // Under a spend ceiling the list narrows rather than disappearing: routine
      // fees become committable up to the limit, deposits and contracts do not.
      if (p.authority.spend)
        return [alwaysDeferRule(p.principalName, SPEND_NARROWED_DEFER_CATEGORIES)];
      return [alwaysDeferRule(p.principalName)];
    }
  },
  {
    order: 56,
    shapes: ["call"],
    compose: (p) =>
      p.authority.spend
        ? [
            spendRule(
              p.principalName,
              p.authority.spend.limit,
              p.authority.spend.currency,
              p.authority.spend.basis
            )
          ]
        : []
  },
  {
    order: 60,
    shapes: ["call"],
    compose: (p) =>
      p.authority.authorizedCommitments && p.authority.authorizedCommitments.length > 0
        ? [authorityRule(p.principalName, p.authority.authorizedCommitments)]
        : []
  },
  // A callback number is something the agent GIVES OUT when asked — an active
  // exchange with a speaking counterparty. A meeting notetaker is never asked,
  // and could not answer if it were.
  {
    order: 70,
    shapes: ["call"],
    compose: (p) => (p.callback ? [callbackRule(p.principalName, p.callback.number)] : [])
  },
  // Pronunciation says a person's name aloud, whenever the agent next speaks
  // that name — true whether the agent is talking to a counterparty or
  // announcing itself into a bridge. Kept for both shapes.
  {
    order: 80,
    shapes: ["call", "meeting"],
    compose: (p) =>
      p.pronunciation && p.pronunciation.length > 0 ? [p.pronunciation.join(" ")] : []
  },
  // Patience is about waiting out a lookup mid-negotiation on a two-party
  // call. A meeting notetaker is either silently waiting for the room already
  // (the order-15 waiting-room rail) or silently taking notes — there is no
  // negotiation pause for this rail to name.
  {
    order: 85,
    shapes: ["call"],
    compose: (p) => (p.patience?.expectLookupPauses ? [PATIENCE_RULE] : [])
  },
  // Wrap-up is a goodbye ceremony for a call the agent is closing. A meeting
  // notetaker never closes the meeting — it is one silent leg on a bridge
  // other people end — and cannot speak a wrap-up even if it wanted to, once
  // notetaking has begun.
  { order: 90, shapes: ["call"], compose: (p) => (p.wrapUp?.enabled ? [WRAP_UP_RULE] : []) },
  // Voicemail is an outbound-dial concept — the far end never answered. A
  // meeting is joined via a bridge; there is no voicemail state to reach.
  {
    order: 95,
    shapes: ["call"],
    compose: (p) => {
      if (!p.voicemail) return [];
      if (p.voicemail.onMachine === "leaveMessage") {
        return [voicemailLeaveMessage(p.principalName, p.callback?.number)];
      }
      // With a tree declared navigable, only a voicemail is a dead end. The
      // unnarrowed rail says "voicemail OR an automated system", which is what
      // told the model to hang up on every phone tree it ever met.
      return p.ivr ? [VOICEMAIL_HANGUP_IVR] : [VOICEMAIL_HANGUP];
    }
  },
  // The deployment's escape hatch — whatever it says, it applies regardless of
  // shape; suppressing it here would silently drop caller-authored guardrails
  // instead of composing them, the opposite of what an escape hatch is for.
  {
    order: 99,
    shapes: ["call", "meeting"],
    compose: (p) => (p.extraGuardrails ? [...p.extraGuardrails] : [])
  }
];

/**
 * Compose the ordered guardrail sentences for a policy. Pure.
 *
 * Selects a rail SET by call shape before composing: a meeting
 * (`policy.meeting.announce === true` — the same condition the cross-plane
 * pairing rule in schema.ts's `callEnvelopeSchema` checks execution.meeting
 * against) composes only the rails marked `shapes: [..., "meeting"]` above;
 * every other rail is call-shape only and is filtered out entirely, not
 * merely left to compose an empty array from a falsy field. That distinction
 * matters because the policy schema REQUIRES `identity`, `disclosure`,
 * `scope`, `grounding`, and `deferral` — a meeting envelope cannot omit them —
 * so filtering by shape, not by field truthiness, is the only way those
 * fields' rails can be kept off a meeting call. (A handful of optional fields
 * that are ALSO meaningless for a meeting — `authority.spend`,
 * `authority.authorizedCommitments`, `callback`, `wrapUp`, `voicemail` — are
 * instead REJECTED outright by the envelope schema, since an optional field
 * CAN be declined; see the meeting cross-plane check in schema.ts for why
 * rejecting is preferred to silently suppressing wherever it's possible.)
 *
 * `preferences` defaults to empty, so every existing single-argument call site
 * composes exactly what it composed before. */
export function composePolicy(policy: CallPolicy, preferences: readonly string[] = []): string[] {
  const shape: CallShape = policy.meeting?.announce === true ? "meeting" : "call";
  return [...RAILS]
    .filter((rail) => rail.shapes.includes(shape))
    .sort((a, b) => a.order - b.order)
    .flatMap((rail) => rail.compose(policy, preferences));
}

/** Fixed, non-parameterized guardrail sentences — safe to check for verbatim
 * recitation in a model's spoken transcript as a marker-leak signal. */
export const CANARY_PHRASES: readonly string[] = Object.freeze([
  SCOPE_STATEMENT,
  REDIRECT_LANGUAGE,
  DEFERRAL_CORE
]);

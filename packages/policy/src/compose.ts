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
  SPEND_NARROWED_DEFER_CATEGORIES
} from "./constants.js";

/** Preset catalog identifiers — used by the harness disclosure evaluator. Not a
 * core type; the three modes exist only as preset names in this package. */
export type CallMode = "principal" | "represented" | "transactional";

/** A rail: its fixed emission order and a pure compose fn. Adding a behavior =
 * add one entry here + a test. The composer names no rail individually. */
interface Rail {
  order: number;
  /** `preferences` comes from the Brief, not the policy — it is caller CONTENT,
   * not behavior — but its rail must interleave with policy rails at order 45,
   * before deferral. Threading it as a second argument keeps composePolicy pure
   * and keeps Brief free of policy concerns. */
  compose(p: CallPolicy, preferences: readonly string[]): string[];
}

const RAILS: readonly Rail[] = [
  // The scope statement swaps to its adjacency variant when adjacencies exist:
  // "no other scenario available to you" contradicts a declared extension.
  {
    order: 10,
    compose: (p) =>
      p.scope.lock
        ? [(p.scope.adjacent?.length ?? 0) > 0 ? SCOPE_STATEMENT_WITH_ADJACENT : SCOPE_STATEMENT]
        : []
  },
  { order: 11, compose: (p) => (p.scope.lock ? [REDIRECT_LANGUAGE] : []) },
  {
    order: 12,
    compose: (p) =>
      (p.scope.adjacent?.length ?? 0) > 0 ? [adjacentScopeRule(p.scope.adjacent ?? [])] : []
  },
  { order: 15, compose: (p) => (p.ivr ? [ivrRule(p.ivr.goal, p.ivr.menuHints ?? [])] : []) },
  {
    order: 20,
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
  { order: 25, compose: (p) => (p.scope.lock === false ? [selfTopicSwitch()] : []) },
  {
    order: 30,
    compose: (p) => (p.disclosure.honestIfAsked ? [honestIfAsked(p.principalName)] : [])
  },
  {
    order: 31,
    compose: (p) => (p.disclosure.volunteer ? [volunteerDisclosure(p.principalName)] : [])
  },
  { order: 40, compose: (p) => (p.grounding.antiInvention ? [selfGrounding()] : []) },
  // Before deferral at 50, deliberately — deferral must read as the fallback for
  // everything the preferences do not cover, not the other way round.
  {
    order: 45,
    compose: (p, preferences) =>
      preferences.length > 0 ? [preferencesRule(p.principalName, preferences)] : []
  },
  { order: 50, compose: (p) => (p.deferral.enabled ? [deferralRule(p.principalName)] : []) },
  {
    order: 55,
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
    compose: (p) =>
      p.authority.authorizedCommitments && p.authority.authorizedCommitments.length > 0
        ? [authorityRule(p.principalName, p.authority.authorizedCommitments)]
        : []
  },
  {
    order: 70,
    compose: (p) => (p.callback ? [callbackRule(p.principalName, p.callback.number)] : [])
  },
  {
    order: 80,
    compose: (p) =>
      p.pronunciation && p.pronunciation.length > 0 ? [p.pronunciation.join(" ")] : []
  },
  { order: 85, compose: (p) => (p.patience?.expectLookupPauses ? [PATIENCE_RULE] : []) },
  { order: 90, compose: (p) => (p.wrapUp?.enabled ? [WRAP_UP_RULE] : []) },
  {
    order: 95,
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
  { order: 99, compose: (p) => (p.extraGuardrails ? [...p.extraGuardrails] : []) }
];

/** Compose the ordered guardrail sentences for a policy. Pure.
 *
 * `preferences` defaults to empty, so every existing single-argument call site
 * composes exactly what it composed before. */
export function composePolicy(policy: CallPolicy, preferences: readonly string[] = []): string[] {
  return [...RAILS]
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

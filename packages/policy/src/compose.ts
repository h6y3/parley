import type { CallPolicy } from "./schema.js";
import {
  SCOPE_STATEMENT, REDIRECT_LANGUAGE, DEFERRAL_CORE, WRAP_UP_RULE, VOICEMAIL_HANGUP,
  deferralRule, authorityRule, alwaysDeferRule, callbackRule, honestIfAsked, volunteerDisclosure,
  onBehalfIntro, silentIntro, selfIdentity, selfTopicSwitch, selfGrounding, voicemailLeaveMessage
} from "./constants.js";

/** Preset catalog identifiers — used by the harness disclosure evaluator. Not a
 * core type; the three modes exist only as preset names in this package. */
export type CallMode = "principal" | "represented" | "transactional";

/** A rail: its fixed emission order and a pure compose fn. Adding a behavior =
 * add one entry here + a test. The composer names no rail individually. */
interface Rail {
  order: number;
  compose(p: CallPolicy): string[];
}

const RAILS: readonly Rail[] = [
  { order: 10, compose: (p) => (p.scope.lock ? [SCOPE_STATEMENT] : []) },
  { order: 11, compose: (p) => (p.scope.lock ? [REDIRECT_LANGUAGE] : []) },
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
  { order: 30, compose: (p) => (p.disclosure.honestIfAsked ? [honestIfAsked(p.principalName)] : []) },
  { order: 31, compose: (p) => (p.disclosure.volunteer ? [volunteerDisclosure(p.principalName)] : []) },
  { order: 40, compose: (p) => (p.grounding.antiInvention ? [selfGrounding()] : []) },
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
      return [overrides.length > 0 ? alwaysDeferRule(p.principalName, overrides.join(", ")) : alwaysDeferRule(p.principalName)];
    }
  },
  {
    order: 60,
    compose: (p) =>
      p.authority.authorizedCommitments && p.authority.authorizedCommitments.length > 0
        ? [authorityRule(p.principalName, p.authority.authorizedCommitments)]
        : []
  },
  { order: 70, compose: (p) => (p.callback ? [callbackRule(p.principalName, p.callback.number)] : []) },
  { order: 80, compose: (p) => (p.pronunciation && p.pronunciation.length > 0 ? [p.pronunciation.join(" ")] : []) },
  { order: 90, compose: (p) => (p.wrapUp?.enabled ? [WRAP_UP_RULE] : []) },
  {
    order: 95,
    compose: (p) => {
      if (!p.voicemail) return [];
      return p.voicemail.onMachine === "leaveMessage"
        ? [voicemailLeaveMessage(p.principalName, p.callback?.number)]
        : [VOICEMAIL_HANGUP];
    }
  },
  { order: 99, compose: (p) => (p.extraGuardrails ? [...p.extraGuardrails] : []) }
];

/** Compose the ordered guardrail sentences for a policy. Pure. */
export function composePolicy(policy: CallPolicy): string[] {
  return [...RAILS]
    .sort((a, b) => a.order - b.order)
    .flatMap((rail) => rail.compose(policy));
}

/** Fixed, non-parameterized guardrail sentences — safe to check for verbatim
 * recitation in a model's spoken transcript as a marker-leak signal. */
export const CANARY_PHRASES: readonly string[] = Object.freeze([SCOPE_STATEMENT, REDIRECT_LANGUAGE, DEFERRAL_CORE]);

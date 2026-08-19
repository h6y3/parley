import type { CallExecution } from "@parley/core";
import type { CallPolicy } from "./schema.js";

export function principalCall(opts: { principalName: string }): CallPolicy {
  return {
    principalName: opts.principalName,
    identity: { style: "self" },
    disclosure: { honestIfAsked: false, volunteer: false },
    scope: { lock: false },
    grounding: { antiInvention: true },
    deferral: { enabled: false },
    authority: {}
  };
}

export function representedCall(opts: {
  principalName: string;
  role?: string;
  callbackNumber?: string;
  authorizedCommitments?: readonly string[];
  pronunciation?: readonly string[];
  extraGuardrails?: readonly string[];
}): CallPolicy {
  return {
    principalName: opts.principalName,
    identity: { style: "onBehalf", role: opts.role ?? "personal assistant" },
    disclosure: { honestIfAsked: true, volunteer: false },
    scope: { lock: true },
    grounding: { antiInvention: false },
    deferral: { enabled: true },
    authority: opts.authorizedCommitments
      ? { authorizedCommitments: [...opts.authorizedCommitments] }
      : {},
    ...(opts.callbackNumber ? { callback: { number: opts.callbackNumber } } : {}),
    wrapUp: { enabled: true },
    voicemail: { onMachine: "leaveMessage" },
    ...(opts.pronunciation ? { pronunciation: [...opts.pronunciation] } : {}),
    ...(opts.extraGuardrails ? { extraGuardrails: [...opts.extraGuardrails] } : {})
  };
}

export function transactionalCall(opts: {
  principalName: string;
  recipientName?: string;
  callbackNumber?: string;
  authorizedCommitments?: readonly string[];
  pronunciation?: readonly string[];
  extraGuardrails?: readonly string[];
  /** Permitted extensions beyond the objective. Each is plain prose stating what
   * may additionally be handled; the composed rail closes the set. */
  adjacent?: readonly string[];
  /** Whose department the call is trying to reach through a menu. Requires a
   * matching `execution.ivr` — see `navigableCall`. */
  ivrGoal?: string;
  menuHints?: readonly string[];
  /** A ceiling on what may be agreed to. Narrows the always-defer categories
   * rather than removing them: deposits and contracts still always defer. */
  spend?: { limit: number; currency: string; basis: string };
  expectLookupPauses?: boolean;
}): CallPolicy {
  return {
    principalName: opts.principalName,
    identity: opts.recipientName
      ? { style: "silent", recipientName: opts.recipientName }
      : { style: "silent" },
    disclosure: { honestIfAsked: true, volunteer: false },
    scope: { lock: true, ...(opts.adjacent ? { adjacent: [...opts.adjacent] } : {}) },
    grounding: { antiInvention: false },
    deferral: { enabled: true },
    authority: {
      ...(opts.authorizedCommitments
        ? { authorizedCommitments: [...opts.authorizedCommitments] }
        : {}),
      ...(opts.spend ? { spend: opts.spend } : {})
    },
    ...(opts.expectLookupPauses !== undefined
      ? { patience: { expectLookupPauses: opts.expectLookupPauses } }
      : {}),
    ...(opts.ivrGoal
      ? {
          ivr: { goal: opts.ivrGoal, ...(opts.menuHints ? { menuHints: [...opts.menuHints] } : {}) }
        }
      : {}),
    ...(opts.callbackNumber ? { callback: { number: opts.callbackNumber } } : {}),
    wrapUp: { enabled: true },
    voicemail: { onMachine: "hangUp" },
    ...(opts.pronunciation ? { pronunciation: [...opts.pronunciation] } : {}),
    ...(opts.extraGuardrails ? { extraGuardrails: [...opts.extraGuardrails] } : {})
  };
}

/** Builds the execution plane for a call that must navigate a menu, close
 * itself, and report what it agreed to.
 *
 * Every block is independent: pass only what this call needs, because presence
 * is what declares a tool. `navigableCall({})` is a valid empty execution, which
 * is exactly equivalent to sending none. */
export function navigableCall(opts: {
  maxPresses?: number;
  allowedDigits?: string;
  onUnrecognized?: "zeroOut" | "waitForHuman" | "hangUp";
  outcomeFields?: { name: string; description: string }[];
  /** Binds an outcome field to a hard limit. Pair it with `representedCall`'s
   * spend authority — the envelope schema requires both, and refuses an
   * advisory ceiling with nothing enforcing it. */
  spendCeiling?: { field: string; limit: number };
  requireOutcomeBeforeEnd?: boolean;
  maxDurationSeconds?: number;
  maxSilenceSeconds?: number;
  silenceMs?: number;
  detectAnsweringMachine?: "enable" | "detectMessageEnd";
}): CallExecution {
  return {
    ...(opts.maxPresses !== undefined
      ? {
          ivr: {
            maxPresses: opts.maxPresses,
            allowedDigits: opts.allowedDigits ?? "0123456789*#",
            onUnrecognized: opts.onUnrecognized ?? "zeroOut"
          }
        }
      : {}),
    ...(opts.requireOutcomeBeforeEnd !== undefined
      ? { closure: { requireOutcomeBeforeEnd: opts.requireOutcomeBeforeEnd } }
      : {}),
    ...(opts.outcomeFields ? { outcome: { fields: opts.outcomeFields } } : {}),
    ...(opts.spendCeiling ? { spendCeiling: { ...opts.spendCeiling } } : {}),
    // maxSilenceSeconds is meaningless without a duration cap to sit inside, and
    // the schema nests it under limits — so it rides along or not at all.
    ...(opts.maxDurationSeconds !== undefined
      ? {
          limits: {
            maxDurationSeconds: opts.maxDurationSeconds,
            ...(opts.maxSilenceSeconds !== undefined
              ? { maxSilenceSeconds: opts.maxSilenceSeconds }
              : {})
          }
        }
      : {}),
    ...(opts.silenceMs !== undefined ? { turnDetection: { silenceMs: opts.silenceMs } } : {}),
    ...(opts.detectAnsweringMachine ? { detection: { mode: opts.detectAnsweringMachine } } : {})
  };
}

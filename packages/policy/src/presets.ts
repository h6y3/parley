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
    authority: opts.authorizedCommitments ? { authorizedCommitments: [...opts.authorizedCommitments] } : {},
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
}): CallPolicy {
  return {
    principalName: opts.principalName,
    identity: opts.recipientName ? { style: "silent", recipientName: opts.recipientName } : { style: "silent" },
    disclosure: { honestIfAsked: true, volunteer: false },
    scope: { lock: true },
    grounding: { antiInvention: false },
    deferral: { enabled: true },
    authority: opts.authorizedCommitments ? { authorizedCommitments: [...opts.authorizedCommitments] } : {},
    ...(opts.callbackNumber ? { callback: { number: opts.callbackNumber } } : {}),
    wrapUp: { enabled: true },
    voicemail: { onMachine: "hangUp" },
    ...(opts.pronunciation ? { pronunciation: [...opts.pronunciation] } : {}),
    ...(opts.extraGuardrails ? { extraGuardrails: [...opts.extraGuardrails] } : {})
  };
}

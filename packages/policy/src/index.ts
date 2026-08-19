export const PACKAGE_NAME = "@parley/policy";
export {
  parseCallPolicy,
  parseCallEnvelope,
  callPolicySchema,
  callEnvelopeSchema,
  callExecutionSchema,
  WIRE_VERSION
} from "./schema.js";
export type {
  CallPolicy,
  Identity,
  CallEnvelope,
  CallEnvelopeWithPolicy,
  CallEnvelopeWithGuardrails
} from "./schema.js";
export { composePolicy, CANARY_PHRASES } from "./compose.js";
export type { CallMode } from "./compose.js";
export { principalCall, representedCall, transactionalCall, navigableCall } from "./presets.js";
// OPENING_TRIGGER is NOT re-exported here. It lived in this package as a second
// copy of the constant in @parley/core, which nothing imported and which drifted
// the moment the real one changed — the live-call fix updated core and left this
// one reading the old text. @parley/policy has no runtime dependency on core by
// design, so the copy could not be replaced by a re-export; the only way to have
// one source of truth is to have one. Import it from @parley/core.
export { SCOPE_STATEMENT } from "./constants.js";

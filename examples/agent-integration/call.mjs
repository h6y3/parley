// examples/agent-integration/call.mjs — a minimal agent-framework integration adapter.
// Proves "framework-agnostic": this uses ONLY Parley's public HTTP API — no
// @parley/core or @parley/policy import, no agent-framework-specific hook. A prep step
// assembles a full call envelope — { version, brief, policy } — and POSTs it
// as-is to the running daemon's /call; the server composes the policy into
// guardrails and validates the whole envelope (see @parley/policy's
// parseCallEnvelope). This script never inspects or builds the policy itself —
// see the sibling README for how a prep step derives `policy` from a
// @parley/policy preset (principalCall / representedCall / transactionalCall).
//
// Usage: node examples/agent-integration/call.mjs ./examples/briefs/represented.json
import { readFileSync } from "node:fs";

const envelopePath = process.argv[2];
if (!envelopePath) {
  console.error("usage: node call.mjs <envelope.json>");
  process.exit(1);
}
const envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
const daemonUrl = process.env.PARLEY_DAEMON_URL ?? "http://127.0.0.1:3334";

// POST /call is the only route that can dial a human being, so it requires the
// daemon's shared secret as a bearer token. Read it from the environment — never
// a CLI argument, which lands in shell history and `ps` output.
const callToken = process.env.PARLEY_CALL_TOKEN;
if (!callToken) {
  console.error("PARLEY_CALL_TOKEN must be set — the daemon answers 401 without it");
  process.exit(1);
}

const res = await fetch(`${daemonUrl}/call`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${callToken}`
  },
  body: JSON.stringify(envelope)
});
const json = await res.json();
if (!res.ok) {
  console.error(`call failed (${res.status}):`, json.error);
  process.exit(1);
}
console.log("call queued:", json.callId);

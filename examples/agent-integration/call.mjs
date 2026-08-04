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

const res = await fetch(`${daemonUrl}/call`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(envelope)
});
const json = await res.json();
if (!res.ok) {
  console.error(`call failed (${res.status}):`, json.error);
  process.exit(1);
}
console.log("call queued:", json.callId);

import {
  CallSession,
  type AudioCodec,
  type RealtimeProvider,
  type TelephonyProvider
} from "@parley/core";
import { parseCallEnvelope, composePolicy } from "@parley/policy";
import type { NumberAllowlist, HostAllowlist } from "./allowlist.js";
import type { PendingSessions } from "./pending-sessions.js";

export interface HttpRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  rawBody: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ServerDeps {
  telephony: TelephonyProvider;
  realtime: RealtimeProvider;
  codec: AudioCodec;
  from: string;
  publicHost: string;
  model: string;
  numberAllowlist: NumberAllowlist;
  hostAllowlist: HostAllowlist;
  pending: PendingSessions;
}

function json(status: number, value: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export async function handleHttpRequest(req: HttpRequest, deps: ServerDeps): Promise<HttpResponse> {
  if (req.method === "GET" && req.path === "/healthz") return json(200, { ok: true });
  if (req.method === "POST" && req.path === "/call") return handleCall(req, deps);
  if (req.method === "POST" && req.path === "/twilio/answer") return handleAnswer(req, deps);
  return json(404, { error: "not found" });
}

async function handleCall(req: HttpRequest, deps: ServerDeps): Promise<HttpResponse> {
  let envelope;
  try {
    envelope = parseCallEnvelope(JSON.parse(req.rawBody));
  } catch {
    return json(400, { error: "invalid call envelope" });
  }
  const { brief } = envelope;
  // Dual wire shape: a typed `policy` is composed here; already-composed raw
  // `guardrails[]` are passed straight through. `@parley/policy` remains a
  // required server dependency for the typed path only.
  const guardrails = "policy" in envelope ? composePolicy(envelope.policy) : envelope.guardrails;
  if (!deps.numberAllowlist.permits(brief.to)) {
    return json(403, { error: "number not permitted" });
  }
  const session = new CallSession({
    brief,
    guardrails,
    telephony: deps.telephony,
    realtime: deps.realtime,
    codec: deps.codec,
    from: deps.from,
    answerWebhookUrl: `https://${deps.publicHost}/twilio/answer`,
    model: deps.model
  });
  let result;
  try {
    result = await session.originate();
  } catch {
    return json(502, { error: "origination error" });
  }
  if (result.status === "failed" || !result.providerCallId) {
    return json(502, { error: "origination failed" });
  }
  deps.pending.set(result.providerCallId, session);
  return json(202, { callId: result.providerCallId });
}

function handleAnswer(req: HttpRequest, deps: ServerDeps): HttpResponse {
  const host = (req.headers.host ?? "").split(":")[0];
  // SSRF-safe: only trust a host on the allowlist; reconstruct the signed URL
  // from it, never from the raw Host header value alone.
  if (!deps.hostAllowlist.permits(host)) {
    return { status: 403, headers: { "content-type": "text/plain" }, body: "forbidden host" };
  }
  const fullUrl = `https://${host}${req.path}${req.query ? `?${req.query}` : ""}`;
  if (
    !deps.telephony.verifyWebhookSignature({ headers: req.headers, rawBody: req.rawBody, fullUrl })
  ) {
    return { status: 403, headers: { "content-type": "text/plain" }, body: "bad signature" };
  }
  const callSid = new URLSearchParams(req.rawBody).get("CallSid") ?? "";
  const session = deps.pending.get(callSid);
  if (!session) {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "no pending call" };
  }
  const answer = deps.telephony.buildAnswerResponse({
    callId: callSid,
    mediaStreamUrl: `wss://${deps.publicHost}/media/${callSid}`
  });
  return { status: 200, headers: { "content-type": answer.contentType }, body: answer.body };
}

import { createHash, timingSafeEqual } from "node:crypto";
import {
  CallSession,
  type AudioCodec,
  type FrameConverter,
  type RealtimeProvider,
  type TelephonyProvider,
  type TranscriptionProvider
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
  /** Shared secret required on POST /call as `Authorization: Bearer <token>`.
   *
   * Required in the type on purpose: constructing a server must be a conscious
   * decision about who may originate a call, not a field you can forget. Empty
   * or absent at runtime means the daemon refuses to dial for anyone — see
   * `authorizeCall`. */
  callToken: string | undefined;
  /** The listening plane, matching the shape `CallSessionParams.transcription`
   * already takes. Optional because meeting support is optional — a
   * deployment with no transcription provider configured can still place
   * ordinary calls. What it must NOT do is let a meeting envelope through
   * when this is absent: without it, `beginNotetaking()` throws AFTER
   * consent is granted (`CallSession` gates that at the tool-call boundary,
   * not at intake), which means the agent has told a room "I will take
   * notes now" and then silently takes none, still live on the speaking
   * plane. `handleCall` refuses the request instead — see the check right
   * after envelope parsing. */
  transcription?: { provider: TranscriptionProvider; convert: FrameConverter };
  /** Whether anything is wired to RECEIVE a finished meeting.
   *
   * The listening plane and the artifact sink are two independent pieces of
   * configuration, and a daemon can hold exactly one of them. With
   * `DEEPGRAM_API_KEY` set and `PARLEY_CALL_RECORDS_PATH` unset, the meeting
   * was accepted, the bridge dialled, consent obtained on the record and notes
   * taken for hours — and no transcript, no record and no hook ever existed,
   * with nothing logging that. The room was told its words were being noted;
   * they went nowhere.
   *
   * So the 503 covers BOTH halves. `createParleyServer` derives this from
   * `onCallCompleted`, which is the thing that turns a finished call into the
   * files a reader consumes: no hook, no artifacts, no meeting. */
  meetingArtifactsConfigured: boolean;
}

function json(status: number, value: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

/** Constant-length, constant-time comparison.
 *
 * Digesting first means both operands are always 32 bytes, so `timingSafeEqual`
 * never throws on a length mismatch and the comparison leaks neither the
 * token's length nor how far a guess matched. */
function secretEquals(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** RFC 7235 makes the auth-scheme case-insensitive; the token itself is not. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * The only thing between the public internet and a billed outbound call.
 *
 * Binding loopback does not protect this route. Twilio has to reach
 * /twilio/answer from the public internet, so any real deployment fronts the
 * daemon with a tunnel or reverse proxy mapping a whole hostname to it — and
 * that path reaches /call too. Hence primary control, not defence in depth.
 *
 * Fails CLOSED on an unconfigured token. An operator who has not set
 * PARLEY_CALL_TOKEN gets a daemon that will not dial for anybody, never one
 * that dials for everybody; "the secret is missing, so skip the check" is the
 * shape of most auth bypasses.
 */
function authorizeCall(req: HttpRequest, deps: ServerDeps): HttpResponse | null {
  const expected = (deps.callToken ?? "").trim();
  if (!expected) return json(503, { error: "call authentication is not configured" });
  const presented = bearerToken(req.headers["authorization"]);
  if (presented === null || !secretEquals(presented, expected)) {
    return json(401, { error: "unauthorized" });
  }
  return null;
}

export async function handleHttpRequest(req: HttpRequest, deps: ServerDeps): Promise<HttpResponse> {
  if (req.method === "GET" && req.path === "/healthz") return json(200, { ok: true });
  if (req.method === "POST" && req.path === "/call") {
    // Authorize BEFORE parsing. Doing it after would let an anonymous caller
    // tell a malformed envelope (400) from an unlisted number (403) and so
    // enumerate the callable-number allowlist without ever holding the token.
    const denied = authorizeCall(req, deps);
    if (denied) return denied;
    return handleCall(req, deps);
  }
  // Deliberately NOT token-gated: Twilio cannot present a bearer token. Its
  // control is verifyWebhookSignature, checked inside handleAnswer.
  if (req.method === "POST" && req.path === "/twilio/answer") return handleAnswer(req, deps);
  if (req.method === "POST" && req.path === "/twilio/status") return handleStatus(req, deps);
  return json(404, { error: "not found" });
}

async function handleCall(req: HttpRequest, deps: ServerDeps): Promise<HttpResponse> {
  let envelope;
  try {
    envelope = parseCallEnvelope(JSON.parse(req.rawBody));
  } catch {
    return json(400, { error: "invalid call envelope" });
  }
  // Fail CLOSED, before the call is placed. Discovering the missing plane
  // after consent is granted is the failure this exists to prevent: the
  // agent has told the room it will take notes, the gate has authorized
  // begin_notetaking, and only THEN does CallSession learn there is nowhere
  // to send the audio — silently taking no notes while still live on the
  // speaking plane. Refusing here costs a caller one rejected request; the
  // alternative costs a room its honesty about being recorded.
  if (envelope.execution?.meeting !== undefined) {
    if (!deps.transcription) {
      return json(503, {
        error:
          "meeting calls require a transcription plane, which this daemon does not have configured"
      });
    }
    // The other half of the same promise. A meeting whose artifacts have
    // nowhere to go is a meeting nobody can read, and the room was told
    // otherwise — refusing costs one rejected request, and the alternative
    // costs a meeting.
    if (!deps.meetingArtifactsConfigured) {
      return json(503, {
        error:
          "meeting calls require somewhere to write the transcript and record, which this " +
          "daemon does not have configured"
      });
    }
  }
  const { brief } = envelope;
  // Dual wire shape: a typed `policy` is composed here; already-composed raw
  // `guardrails[]` are passed straight through. `@parley/policy` remains a
  // required server dependency for the typed path only.
  // brief.preferences is caller CONTENT but its rail interleaves with the
  // policy rails (before deferral), so composition needs both halves.
  const guardrails =
    "policy" in envelope
      ? composePolicy(envelope.policy, brief.preferences ?? [])
      : envelope.guardrails;
  if (!deps.numberAllowlist.permits(brief.to)) {
    return json(403, { error: "number not permitted" });
  }
  if (brief.operation) {
    const reservation = deps.pending.reserveOperation(brief.operation);
    if (reservation !== "reserved") {
      return json(409, { error: `operation ${reservation}` });
    }
  }
  const session = new CallSession({
    brief,
    guardrails,
    telephony: deps.telephony,
    realtime: deps.realtime,
    codec: deps.codec,
    from: deps.from,
    answerWebhookUrl: `https://${deps.publicHost}/twilio/answer`,
    // Dead code since V1: OriginateParams declared this field and nothing ever
    // set it, so no lifecycle event has ever reached a CallSession.
    statusCallbackUrl: `https://${deps.publicHost}/twilio/status`,
    model: deps.model,
    // Never call content — only why a transport ended. A realtime session that
    // dies on connect hangs up the phone the moment the callee answers, and
    // writes no call record (records are written on a clean end), so without
    // this the only evidence anywhere is a caller saying it went dead.
    onDiagnostic: (message) => console.error(`[call] ${message}`),
    ...(envelope.execution ? { execution: envelope.execution } : {}),
    ...(deps.transcription ? { transcription: deps.transcription } : {})
  });
  let result;
  try {
    result = await session.originate();
  } catch {
    if (brief.operation) deps.pending.releaseOperation(brief.operation);
    return json(502, { error: "origination error" });
  }
  if (result.status === "failed" || !result.providerCallId) {
    if (brief.operation) deps.pending.releaseOperation(brief.operation);
    return json(502, { error: "origination failed" });
  }
  deps.pending.set(result.providerCallId, session, brief.operation);
  return json(202, { callId: result.providerCallId });
}

/** Host-allowlist + signature check, shared by every Twilio-originated route.
 *
 * Extracted rather than duplicated: two copies of a security check drift, and
 * the one that drifts is the one nobody is looking at. Returns a response to
 * send on rejection, or null to continue.
 *
 * SSRF-safe: only a host on the allowlist is trusted, and the signed URL is
 * reconstructed from that, never from the raw Host header value alone. */
function verifyTwilioRequest(req: HttpRequest, deps: ServerDeps): HttpResponse | null {
  const host = (req.headers.host ?? "").split(":")[0];
  if (!deps.hostAllowlist.permits(host)) {
    return { status: 403, headers: { "content-type": "text/plain" }, body: "forbidden host" };
  }
  const fullUrl = `https://${host}${req.path}${req.query ? `?${req.query}` : ""}`;
  if (
    !deps.telephony.verifyWebhookSignature({ headers: req.headers, rawBody: req.rawBody, fullUrl })
  ) {
    return { status: 403, headers: { "content-type": "text/plain" }, body: "bad signature" };
  }
  return null;
}

/** Twilio's AnsweredBy vocabulary is open-ended and has grown before
 * (machine_end_beep, machine_end_silence, machine_end_other). Every machine_*
 * variant collapses to "machine", and anything unrecognised becomes "unknown"
 * rather than being passed through — a value we cannot interpret must not look
 * like one we can. */
function mapAnsweredBy(raw: string | null): "human" | "machine" | "fax" | "unknown" | undefined {
  if (!raw) return undefined;
  if (raw === "human") return "human";
  if (raw === "fax") return "fax";
  if (raw.startsWith("machine")) return "machine";
  return "unknown";
}

/** Carrier lifecycle callbacks. Signature-verified exactly like /twilio/answer,
 * and deliberately NOT token-gated for the same reason: Twilio cannot present a
 * bearer token. Always 204 — Twilio wants no TwiML here, and an unknown CallSid
 * is routine rather than an error (a completed call has already been evicted
 * from the pending map by the time its final callback lands). */
function handleStatus(req: HttpRequest, deps: ServerDeps): HttpResponse {
  const denied = verifyTwilioRequest(req, deps);
  if (denied) return denied;
  const params = new URLSearchParams(req.rawBody);
  const callId = params.get("CallSid") ?? "";
  const callStatus = params.get("CallStatus");
  const session = deps.pending.get(callId);
  const answeredBy = mapAnsweredBy(params.get("AnsweredBy"));
  if (session && callStatus === "answered") {
    session.noteLifecycleEvent({ type: "answered", ...(answeredBy ? { answeredBy } : {}) });
  }
  if (["busy", "canceled", "completed", "failed", "no-answer"].includes(callStatus ?? "")) {
    deps.pending.deleteIfUnconnected(callId);
  }
  return { status: 204, headers: {}, body: "" };
}

function handleAnswer(req: HttpRequest, deps: ServerDeps): HttpResponse {
  const denied = verifyTwilioRequest(req, deps);
  if (denied) return denied;
  const callSid = new URLSearchParams(req.rawBody).get("CallSid") ?? "";
  const session = deps.pending.get(callSid);
  if (!session) {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "no pending call" };
  }
  // With MachineDetection enabled Twilio delays this webhook until it has
  // classified the answer, and reports the verdict here rather than on a status
  // callback — so this is where "a machine picked up" stops being a guess.
  const answeredBy = mapAnsweredBy(new URLSearchParams(req.rawBody).get("AnsweredBy"));
  session.noteLifecycleEvent({ type: "answered", ...(answeredBy ? { answeredBy } : {}) });
  const answer = deps.telephony.buildAnswerResponse({
    callId: callSid,
    mediaStreamUrl: `wss://${deps.publicHost}/media/${callSid}`
  });
  return { status: 200, headers: { "content-type": answer.contentType }, body: answer.body };
}

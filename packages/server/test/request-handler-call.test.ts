import { describe, expect, it, vi } from "vitest";
import {
  CallSession,
  MULAW_8K,
  PCM_16K,
  type AudioCodec,
  type Brief,
  type FrameConverter,
  type RealtimeProvider,
  type TelephonyProvider,
  type TranscriptionProvider
} from "@parley/core";
import { representedCall, type CallPolicy } from "@parley/policy";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { PendingSessions } from "../src/pending-sessions.js";
import type { RealtimeRegistry } from "../src/realtime-registry.js";
import { handleHttpRequest, type HttpRequest, type ServerDeps } from "../src/request-handler.js";

// Relabels without touching bytes: these tests verify wiring, not DSP.
const convert: FrameConverter = (f, to) => ({ encoding: to, data: f.data });
const canConvert = (): boolean => true;
const codec: AudioCodec = {
  dtmfTones: () => ({ encoding: MULAW_8K, data: Buffer.alloc(0) })
};
const realtime: RealtimeProvider = {
  name: "fake",
  audio: { accepts: [MULAW_8K], emits: MULAW_8K },
  openingDelivery: "turn",
  continuesAfterToolResponse: false,
  connect: vi.fn()
};

function fakeTelephony(
  originateSpy = vi.fn(async () => ({ providerCallId: "CA777", status: "queued" as const }))
): TelephonyProvider {
  return {
    name: "fake",
    mediaEncoding: MULAW_8K,
    originate: originateSpy,
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: () => ({
      sendOutboundAudio: () => {},
      clearOutboundBuffer: () => {},
      drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
      close: () => {}
    }),
    hangup: async () => {}
  };
}

// Since 2026-08-17, POST /call requires `Authorization: Bearer <callToken>` and
// refuses every call when none is configured. These tests exercise the envelope
// and origination behaviour BEHIND that gate, so they authenticate; the gate
// itself is covered in request-handler-auth.test.ts.
const TOKEN = "test-call-token";

/** A daemon keyed for Gemini alone — the shape every pre-existing test here
 * was written against, when the server held exactly one provider. */
function geminiOnly(provider: RealtimeProvider = realtime): RealtimeRegistry {
  return {
    providers: { gemini: { provider, model: "gemini-3.1-flash-live-preview" } },
    default: "gemini"
  };
}

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    telephony: fakeTelephony(),
    realtime: geminiOnly(),
    codec,
    convert,
    canConvert,
    from: "+14155550001",
    publicHost: "voice.example.com",
    numberAllowlist: createNumberAllowlist(["+14155550002"]),
    hostAllowlist: createHostAllowlist(["voice.example.com"]),
    pending: new PendingSessions(),
    callToken: TOKEN,
    meetingArtifactsConfigured: true,
    ...overrides
  };
}

const brief: Brief = {
  to: "+14155550002",
  persona: "I am Alex Rivera's assistant.",
  objective: "Confirm the reservation.",
  facts: ["Party of four at 7pm."]
};

const policy = representedCall({ principalName: "Alex Rivera", callbackNumber: "+15555550143" });

// A meeting envelope needs a declared execution.meeting block — the exact
// signal both CallSession.isMeeting and request-handler's fail-closed check
// key on (`execution?.meeting !== undefined`) — PAIRED with
// `policy.meeting.announce: true` (@parley/policy's cross-plane rule: the two
// meeting halves must both be present or both absent, same shape as the
// existing policy.ivr/execution.ivr pairing). A separate `meetingPolicy`
// rather than adding `meeting` to the shared `policy` above, which every
// other (non-meeting) test in this file also uses.
//
// `policy` carries `callback`/`wrapUp`/`voicemail` (from `representedCall`'s
// `callbackNumber` and its unconditional wrap-up/voicemail defaults) — all
// three are now REJECTED by the envelope schema once `policy.meeting.announce`
// is true, meaningless for a notetaker that goes voiceless the instant
// consent is granted (see @parley/policy's schema.ts meeting rejections).
// Stripped here rather than left in and exempted: this file is exactly the
// "committed fixture pairs meeting with a now-rejected field" case the
// design brief for that change warned would exist somewhere.
const meetingPolicy: CallPolicy = {
  ...policy,
  meeting: { announce: true, purpose: "take notes for the record" }
};
delete meetingPolicy.callback;
delete meetingPolicy.wrapUp;
delete meetingPolicy.voicemail;
const meetingExecution = {
  meeting: {
    consent: {
      phrase: "go ahead and take notes",
      timeoutSeconds: 180,
      onTimeout: "hangUp" as const
    }
  }
};

function fakeTranscriptionProvider(): TranscriptionProvider {
  return {
    name: "fake-transcription",
    ingress: { audio: true, channels: "mono" },
    accepts: [MULAW_8K, PCM_16K],
    connect: async () => ({
      ready: true,
      sendAudio: () => {},
      flush: async () => {},
      close: async () => {}
    })
  };
}

const identityConvert: FrameConverter = (frame, to) => ({ encoding: to, data: frame.data });

function transcriptionDeps(): NonNullable<ServerDeps["transcription"]> {
  return { provider: fakeTranscriptionProvider(), convert: identityConvert };
}

function callReq(body: unknown): HttpRequest {
  return {
    method: "POST",
    path: "/call",
    query: "",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    rawBody: JSON.stringify(body)
  };
}

describe("handleHttpRequest POST /call", () => {
  it("originates and registers the session, returning 202 + callId", async () => {
    const d = deps();
    const res = await handleHttpRequest(callReq({ version: 1, brief, policy }), d);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ callId: "CA777" });
    expect(d.pending.get("CA777")).toBeInstanceOf(CallSession);
  });

  it("rejects a concurrent operation before originating another call", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA777", status: "queued" as const }));
    const d = deps({ telephony: fakeTelephony(originate) });
    const withOperation = {
      version: 1,
      brief: { ...brief, operation: { id: "reservation-1", attempt: 1, maxAttempts: 3 } },
      policy
    };
    expect((await handleHttpRequest(callReq(withOperation), d)).status).toBe(202);
    const duplicate = await handleHttpRequest(callReq(withOperation), d);
    expect(duplicate.status).toBe(409);
    expect(JSON.parse(duplicate.body)).toEqual({ error: "operation active" });
    expect(originate).toHaveBeenCalledTimes(1);
  });

  it("releases a failed origination for the next numbered attempt", async () => {
    const originate = vi
      .fn()
      .mockResolvedValueOnce({ providerCallId: "", status: "failed" as const })
      .mockResolvedValueOnce({ providerCallId: "CA778", status: "queued" as const });
    const d = deps({ telephony: fakeTelephony(originate) });
    const first = {
      version: 1,
      brief: { ...brief, operation: { id: "reservation-2", attempt: 1, maxAttempts: 3 } },
      policy
    };
    expect((await handleHttpRequest(callReq(first), d)).status).toBe(502);
    const second = {
      ...first,
      brief: { ...first.brief, operation: { id: "reservation-2", attempt: 2, maxAttempts: 3 } }
    };
    expect((await handleHttpRequest(callReq(second), d)).status).toBe(202);
    expect(originate).toHaveBeenCalledTimes(2);
  });

  it("accepts a raw guardrails[] envelope (no typed policy) and passes it through verbatim", async () => {
    const d = deps();
    const guardrails = ["Never discuss pricing.", "Always confirm the callback number."];
    const res = await handleHttpRequest(callReq({ version: 1, brief, guardrails }), d);
    expect(res.status).toBe(202);
    const session = d.pending.get("CA777");
    expect(session).toBeInstanceOf(CallSession);
    const systemInstruction = (session as CallSession).resolveSystemInstruction();
    for (const g of guardrails) expect(systemInstruction).toContain(g);
  });

  it("rejects an envelope carrying both policy and guardrails with 400", async () => {
    const res = await handleHttpRequest(
      callReq({ version: 1, brief, policy, guardrails: ["x"] }),
      deps()
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  it("rejects an envelope carrying neither policy nor guardrails with 400", async () => {
    const res = await handleHttpRequest(callReq({ version: 1, brief }), deps());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  it("rejects an unlisted number with 403 (fail closed) and does not originate", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const d = deps({ telephony: fakeTelephony(originate) });
    const res = await handleHttpRequest(
      callReq({ version: 1, brief: { ...brief, to: "+15555550199" }, policy }),
      d
    );
    expect(res.status).toBe(403);
    expect(originate).not.toHaveBeenCalled();
  });

  it("resolves 502 (not reject) when originate throws (network/DNS/timeout)", async () => {
    const originate = vi.fn(async () => {
      throw new Error("network down");
    });
    const d = deps({ telephony: fakeTelephony(originate) });
    const res = await handleHttpRequest(callReq({ version: 1, brief, policy }), d);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "origination error" });
  });

  it("refuses an unbridgeable realtime/carrier pairing with 503, before dialling, and releases the operation", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA779", status: "queued" as const }));
    const pcmOnly: RealtimeProvider = {
      name: "pcm-only",
      audio: { accepts: [PCM_16K], emits: PCM_16K },
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      connect: vi.fn()
    };
    const d = deps({
      telephony: fakeTelephony(originate),
      realtime: geminiOnly(pcmOnly),
      // A converter with no paths at all: only identity is reachable.
      canConvert: (from, to) => from.codec === to.codec && from.sampleRate === to.sampleRate
    });
    const first = {
      version: 1,
      brief: { ...brief, operation: { id: "reservation-3", attempt: 1, maxAttempts: 3 } },
      policy
    };
    const res = await handleHttpRequest(callReq(first), d);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: "audio contract: no audio conversion path from mulaw@8000 to pcm@16000"
    });
    expect(originate).not.toHaveBeenCalled();

    // The reservation went back: once the daemon can bridge, the next attempt dials.
    d.canConvert = () => true;
    const second = {
      ...first,
      brief: { ...first.brief, operation: { id: "reservation-3", attempt: 2, maxAttempts: 3 } }
    };
    expect((await handleHttpRequest(callReq(second), d)).status).toBe(202);
    expect(originate).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await handleHttpRequest({ ...callReq({}), rawBody: "{bad" }, deps());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  it("rejects an envelope with an unsupported version with 400", async () => {
    const res = await handleHttpRequest(callReq({ version: 3, brief, policy }), deps());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  // Counterpart to the above: 2 used to be the example of a "wrong" version and
  // is now the current one. Pinning both directions means a future version bump
  // has to think about this pair rather than silently widening what is accepted.
  it("accepts version 2", async () => {
    const res = await handleHttpRequest(callReq({ version: 2, brief, policy }), deps());
    expect(res.status).toBe(202);
  });

  it("rejects an envelope with an unknown top-level field with 400", async () => {
    const res = await handleHttpRequest(
      callReq({ version: 1, brief, policy, extra: "nope" }),
      deps()
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  it("404s an unknown route", async () => {
    const res = await handleHttpRequest(
      { method: "GET", path: "/nope", query: "", headers: {}, rawBody: "" },
      deps()
    );
    expect(res.status).toBe(404);
  });

  it("200s /healthz", async () => {
    const res = await handleHttpRequest(
      { method: "GET", path: "/healthz", query: "", headers: {}, rawBody: "" },
      deps()
    );
    expect(res.status).toBe(200);
  });
});

describe("meeting calls and the transcription plane", () => {
  it("REJECTS a meeting envelope at the request boundary when no transcription plane is configured, and never originates", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const d = deps({ telephony: fakeTelephony(originate) }); // no `transcription`
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy: meetingPolicy, execution: meetingExecution }),
      d
    );
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/transcription/i);
    expect(originate).not.toHaveBeenCalled();
    // The property meant is that NOTHING was registered — asserting
    // `pending.get("CA1")` is undefined only proves that one borrowed id
    // (taken from the fake telephony provider, never actually reached since
    // originate() never ran) has no entry; it would still pass if a session
    // were registered under any other id. `size` says what's actually meant.
    expect(d.pending.size).toBe(0);
  });

  it("admits a meeting envelope when a transcription plane IS configured, and the session it creates actually has one attached", async () => {
    const d = deps({ transcription: transcriptionDeps() });
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy: meetingPolicy, execution: meetingExecution }),
      d
    );
    expect(res.status).toBe(202);
    const { callId } = JSON.parse(res.body) as { callId: string };
    const session = d.pending.get(callId) as CallSession;
    expect(session).toBeInstanceOf(CallSession);
    expect(session.isMeeting).toBe(true);

    // The direct proof, not an inference: `beginNotetaking()` throws exactly
    // "... no transcription plane declared" when CallSessionParams.transcription
    // is absent (verified live on `parley serve` before this fix — see the
    // transcription-wiring report). Seed consent, then call it for real; it
    // must NOT throw that error, because the plane this test configured must
    // have actually reached the CallSession this handler constructed.
    session.noteTranscript({
      speaker: "model",
      text: "I'm an AI assistant sitting in for the host.",
      isFinal: true
    });
    session.noteTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    session.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });
    await expect(session.beginNotetaking()).resolves.toBeUndefined();
  });

  // The listening plane and the artifact sink are separate pieces of
  // configuration, and a daemon can hold exactly one of them. With the plane
  // configured and no sink, the meeting was accepted, the bridge dialled,
  // consent obtained on the record and notes taken for the length of the
  // meeting — producing no transcript, no record, and no hook, with nothing
  // anywhere saying so.
  it("REJECTS a meeting envelope when there is nowhere to write its artifacts, and never originates", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const d = deps({
      telephony: fakeTelephony(originate),
      transcription: transcriptionDeps(),
      meetingArtifactsConfigured: false
    });
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy: meetingPolicy, execution: meetingExecution }),
      d
    );
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/transcript and record/i);
    expect(originate).not.toHaveBeenCalled();
    expect(d.pending.size).toBe(0);
  });

  it("an ordinary (non-meeting) call is unaffected by a missing artifact sink — the regression guard", async () => {
    const d = deps({ transcription: transcriptionDeps(), meetingArtifactsConfigured: false });
    const res = await handleHttpRequest(callReq({ version: 1, brief, policy }), d);
    expect(res.status).toBe(202);
  });

  it("an ordinary (non-meeting) call is unaffected whether or not a transcription plane is configured — the regression guard", async () => {
    for (const d of [deps(), deps({ transcription: transcriptionDeps() })]) {
      const res = await handleHttpRequest(callReq({ version: 1, brief, policy }), d);
      expect(res.status).toBe(202);
      const { callId } = JSON.parse(res.body) as { callId: string };
      const session = d.pending.get(callId) as CallSession;
      expect(session.isMeeting).toBe(false);
    }
  });
});

// execution.dial.sendDigits — carrier-side DTMF at origination, end to end
// through the same POST /call path an operator actually calls. The value
// typically carries a bridge passcode and must reach exactly one place: the
// telephony provider's origination request to the carrier. It must never
// reach a log line, a diagnostic message, a thrown error, or the HTTP
// response this handler returns.
describe("execution.dial.sendDigits — must never leak off the origination path", () => {
  // A validly-alphabetic sendDigits (0-9, *, #, w, W only — see
  // SEND_DIGITS_PATTERN) shaped like a real conference passcode, distinctive
  // enough that it cannot collide with any other fixture in this file (a
  // phone number, a CallSid).
  const SECRET_DIGITS = "80097531246#";
  const dialExecution = { dial: { sendDigits: SECRET_DIGITS } };

  it("reaches the telephony provider's originate() call unchanged", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const d = deps({ telephony: fakeTelephony(originate) });
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy, execution: dialExecution }),
      d
    );
    expect(res.status).toBe(202);
    expect(originate).toHaveBeenCalledWith(expect.objectContaining({ sendDigits: SECRET_DIGITS }));
  });

  it("never appears in the 202 response body", async () => {
    const d = deps();
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy, execution: dialExecution }),
      d
    );
    expect(res.body).not.toContain(SECRET_DIGITS);
  });

  it("never appears in a console.error call, on a clean origination", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = deps();
      await handleHttpRequest(callReq({ version: 2, brief, policy, execution: dialExecution }), d);
      for (const call of consoleError.mock.calls) {
        expect(call.join(" ")).not.toContain(SECRET_DIGITS);
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it("never appears in the 502 response, or in a console.error call, when origination fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const originate = vi.fn(async () => {
        throw new Error("network down");
      });
      const d = deps({ telephony: fakeTelephony(originate) });
      const res = await handleHttpRequest(
        callReq({ version: 2, brief, policy, execution: dialExecution }),
        d
      );
      expect(res.status).toBe(502);
      expect(res.body).not.toContain(SECRET_DIGITS);
      for (const call of consoleError.mock.calls) {
        expect(call.join(" ")).not.toContain(SECRET_DIGITS);
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it("never appears in the 400 response when the envelope is otherwise malformed", async () => {
    // A malformed sendDigits (bad alphabet) still trips parseCallEnvelope's
    // generic catch, which discards the ZodError entirely — this pins that
    // behaviour rather than assuming it.
    const d = deps();
    const res = await handleHttpRequest(
      callReq({
        version: 2,
        brief,
        policy,
        execution: { dial: { sendDigits: `${SECRET_DIGITS}!!` } }
      }),
      d
    );
    expect(res.status).toBe(400);
    expect(res.body).not.toContain(SECRET_DIGITS);
  });
});

/** The envelope chooses which of the daemon's realtime providers a call runs
 * on, and every way that choice can be impossible is refused BEFORE anything
 * irreversible: no operation reserved, nothing dialled. A refusal after the
 * reservation would burn a caller's retry budget on our configuration; one
 * after `originate` is a phone that rings for a call that cannot happen. */
describe("per-call realtime provider selection", () => {
  function named(name: string, maxSessionSeconds?: number): RealtimeProvider {
    return {
      name,
      audio: { accepts: [MULAW_8K], emits: MULAW_8K },
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      ...(maxSessionSeconds !== undefined ? { maxSessionSeconds } : {}),
      connect: vi.fn()
    };
  }
  const gemini = named("gemini");
  const deepgram = named("deepgram", 7200);
  const bothKeyed = (defaultKind: "gemini" | "deepgram"): RealtimeRegistry => ({
    providers: {
      gemini: { provider: gemini, model: "gemini-3.8-live" },
      deepgram: { provider: deepgram, model: "gpt-4o-mini" }
    },
    default: defaultKind
  });

  function spiedDeps(overrides: Partial<ServerDeps> = {}) {
    const originate = vi.fn(async () => ({ providerCallId: "CA900", status: "queued" as const }));
    const d = deps({ telephony: fakeTelephony(originate), ...overrides });
    const reserveOperation = vi.spyOn(d.pending, "reserveOperation");
    return { d, originate, reserveOperation };
  }

  const withOperation = {
    ...brief,
    operation: { id: "provider-choice-1", attempt: 1, maxAttempts: 3 }
  };

  it("refuses a provider this daemon has not built with 503 — no reservation, nothing dialled", async () => {
    const { d, originate, reserveOperation } = spiedDeps(); // Gemini only
    const res = await handleHttpRequest(
      callReq({
        version: 2,
        brief: withOperation,
        policy,
        execution: { realtime: { provider: "deepgram" } }
      }),
      d
    );
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: 'realtime provider "deepgram" is not configured on this daemon'
    });
    expect(originate).not.toHaveBeenCalled();
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(d.pending.size).toBe(0);
  });

  it("never falls back silently to a default that could take the call", async () => {
    const { d, originate } = spiedDeps({ realtime: geminiOnly(gemini) });
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy, execution: { realtime: { provider: "deepgram" } } }),
      d
    );
    expect(res.status).toBe(503);
    expect(originate).not.toHaveBeenCalled();
  });

  it("uses the daemon's default when the envelope does not choose", async () => {
    for (const defaultKind of ["gemini", "deepgram"] as const) {
      const { d } = spiedDeps({ realtime: bothKeyed(defaultKind) });
      const res = await handleHttpRequest(callReq({ version: 2, brief, policy }), d);
      expect(res.status).toBe(202);
      const session = d.pending.get("CA900") as CallSession;
      expect(session.realtime).toEqual({
        provider: defaultKind,
        model: defaultKind === "gemini" ? "gemini-3.8-live" : "gpt-4o-mini"
      });
    }
  });

  it("uses the provider the envelope names over the default, with that provider's model", async () => {
    const { d } = spiedDeps({ realtime: bothKeyed("gemini") });
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy, execution: { realtime: { provider: "deepgram" } } }),
      d
    );
    expect(res.status).toBe(202);
    expect((d.pending.get("CA900") as CallSession).realtime).toEqual({
      provider: "deepgram",
      model: "gpt-4o-mini"
    });
  });

  it("refuses with 422 a call whose cap exceeds the provider's session limit — before reserving or dialling", async () => {
    const { d, originate, reserveOperation } = spiedDeps({
      realtime: geminiOnly(named("gemini", 600))
    });
    const res = await handleHttpRequest(
      callReq({
        version: 2,
        brief: withOperation,
        policy,
        execution: { limits: { maxDurationSeconds: 900 } }
      }),
      d
    );
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: "call duration exceeds gemini session limit of 600s"
    });
    expect(originate).not.toHaveBeenCalled();
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(d.pending.size).toBe(0);
  });

  it("measures a call with no declared cap at CALL_MAX_DURATION_SECONDS", async () => {
    const { d, originate } = spiedDeps({ realtime: geminiOnly(named("gemini", 1799)) });
    const res = await handleHttpRequest(callReq({ version: 2, brief, policy }), d);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: "call duration exceeds gemini session limit of 1799s"
    });
    expect(originate).not.toHaveBeenCalled();
  });

  it("admits a call whose cap is exactly the provider's session limit, or within it", async () => {
    for (const maxDurationSeconds of [600, 599]) {
      const { d } = spiedDeps({ realtime: geminiOnly(named("gemini", 600)) });
      const res = await handleHttpRequest(
        callReq({ version: 2, brief, policy, execution: { limits: { maxDurationSeconds } } }),
        d
      );
      expect(res.status).toBe(202);
    }
  });

  it("admits any call on a provider that declares no session limit", async () => {
    const { d } = spiedDeps({ realtime: geminiOnly(named("gemini")) });
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy, execution: { limits: { maxDurationSeconds: 1800 } } }),
      d
    );
    expect(res.status).toBe(202);
  });

  // A meeting's speaking plane retires at consent, so what must fit the
  // provider's session is the pre-consent window, not the meeting. A four-hour
  // meeting (MEETING_MAX_DURATION_SECONDS) fits Deepgram's two-hour session.
  it("measures a meeting by its pre-consent window, not its whole duration", async () => {
    const { d } = spiedDeps({
      realtime: bothKeyed("deepgram"),
      transcription: transcriptionDeps()
    });
    const res = await handleHttpRequest(
      callReq({
        version: 2,
        brief,
        policy: meetingPolicy,
        execution: { ...meetingExecution, limits: { maxDurationSeconds: 14400 } }
      }),
      d
    );
    expect(res.status).toBe(202);
  });

  it("still refuses a meeting whose pre-consent window can outlast the provider's session", async () => {
    const { d, originate, reserveOperation } = spiedDeps({
      realtime: geminiOnly(named("gemini", 120)),
      transcription: transcriptionDeps()
    });
    const res = await handleHttpRequest(
      callReq({ version: 2, brief, policy: meetingPolicy, execution: meetingExecution }),
      d
    );
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: "call duration exceeds gemini session limit of 120s"
    });
    expect(originate).not.toHaveBeenCalled();
    expect(reserveOperation).not.toHaveBeenCalled();
  });

  it("measures a meeting by its duration cap when that ends the call before consent could time out", async () => {
    // Consent window 180s, but the call itself is capped at 60s: the speaking
    // plane lives at most 60s (plus the handoff), which fits a 120s session.
    const { d } = spiedDeps({
      realtime: geminiOnly(named("gemini", 120)),
      transcription: transcriptionDeps()
    });
    const res = await handleHttpRequest(
      callReq({
        version: 2,
        brief,
        policy: meetingPolicy,
        execution: { ...meetingExecution, limits: { maxDurationSeconds: 60 } }
      }),
      d
    );
    expect(res.status).toBe(202);
  });

  it("refuses an unbuilt provider before the number allowlist, so the refusal names the real cause", async () => {
    const { d } = spiedDeps();
    const res = await handleHttpRequest(
      callReq({
        version: 2,
        brief: { ...brief, to: "+15555550199" },
        policy,
        execution: { realtime: { provider: "deepgram" } }
      }),
      d
    );
    expect(res.status).toBe(503);
  });
});

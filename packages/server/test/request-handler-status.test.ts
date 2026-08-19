import { describe, expect, it, vi } from "vitest";
import {
  CallSession,
  type AudioCodec,
  type RealtimeProvider,
  type TelephonyProvider
} from "@parley/core";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { PendingSessions } from "../src/pending-sessions.js";
import { handleHttpRequest, type HttpRequest, type ServerDeps } from "../src/request-handler.js";

const codec: AudioCodec = {
  decodeInbound: (f) => f,
  encodeOutbound: (f) => f,
  dtmfTones: () => ({ encoding: "mulaw8k", data: Buffer.alloc(0) })
};
const realtime: RealtimeProvider = { name: "fake", connect: vi.fn() };

function telephony(verify: boolean): TelephonyProvider {
  return {
    name: "fake",
    originate: async () => ({ providerCallId: "CA1", status: "queued" }),
    buildAnswerResponse: (p) => ({
      contentType: "text/xml",
      body: `<Stream url="${p.mediaStreamUrl}"/>`
    }),
    verifyWebhookSignature: () => verify,
    attachMediaStream: () => ({
      sendOutboundAudio: () => {},
      clearOutboundBuffer: () => {},
      drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
      close: () => {}
    }),
    hangup: async () => {}
  };
}

function deps(verify: boolean): { deps: ServerDeps; session: CallSession } {
  const pending = new PendingSessions();
  const t = telephony(verify);
  const session = new CallSession({
    brief: { to: "+14155550002", persona: "p", objective: "o", facts: [] },
    guardrails: [],
    telephony: t,
    realtime,
    codec,
    from: "+14155550001",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "gemini-3.1-flash-live-preview"
  });
  pending.set("CA1", session);
  return {
    session,
    deps: {
      telephony: t,
      realtime,
      codec,
      from: "+14155550001",
      publicHost: "voice.example.com",
      model: "m",
      numberAllowlist: createNumberAllowlist(["+14155550002"]),
      hostAllowlist: createHostAllowlist(["voice.example.com"]),
      pending,
      callToken: "unused-by-the-status-route"
    }
  };
}

function statusReq(host: string, body: Record<string, string>): HttpRequest {
  return {
    method: "POST",
    path: "/twilio/status",
    query: "",
    headers: {
      host,
      "x-twilio-signature": "sig",
      "content-type": "application/x-www-form-urlencoded"
    },
    rawBody: new URLSearchParams(body).toString()
  };
}

function answerReq(host: string, body: Record<string, string>): HttpRequest {
  return {
    method: "POST",
    path: "/twilio/answer",
    query: "",
    headers: {
      host,
      "x-twilio-signature": "sig",
      "content-type": "application/x-www-form-urlencoded"
    },
    rawBody: new URLSearchParams(body).toString()
  };
}

describe("POST /twilio/status", () => {
  it("rejects an unsigned status callback", async () => {
    const res = await handleHttpRequest(
      statusReq("voice.example.com", { CallSid: "CA1", CallStatus: "completed" }),
      deps(false).deps
    );
    expect(res.status).toBe(403);
  });

  it("rejects a status callback for a host outside the allowlist", async () => {
    const res = await handleHttpRequest(
      statusReq("evil.example.net", { CallSid: "CA1" }),
      deps(true).deps
    );
    expect(res.status).toBe(403);
  });

  it("returns 204 for a signed callback", async () => {
    const res = await handleHttpRequest(
      statusReq("voice.example.com", { CallSid: "CA1", CallStatus: "ringing" }),
      deps(true).deps
    );
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
  });

  // An unknown CallSid is NORMAL: a completed call has already been evicted from
  // the pending map by the time its final status callback lands. 404 would make
  // routine traffic look like an error.
  it("returns 204 and needs no pending session for an unknown CallSid", async () => {
    const res = await handleHttpRequest(
      statusReq("voice.example.com", { CallSid: "NOPE", CallStatus: "completed" }),
      deps(true).deps
    );
    expect(res.status).toBe(204);
  });

  it("is not gated by the call token", async () => {
    const d = deps(true).deps;
    const res = await handleHttpRequest(statusReq("voice.example.com", { CallSid: "CA1" }), d);
    expect(res.status).not.toBe(401);
  });
});

describe("AnsweredBy on the answer webhook", () => {
  it("routes a human answer into the session", async () => {
    const { deps: d, session } = deps(true);
    await handleHttpRequest(
      answerReq("voice.example.com", { CallSid: "CA1", AnsweredBy: "human" }),
      d
    );
    expect(session.answeredBy).toBe("human");
  });

  it("collapses every machine_* variant to machine", async () => {
    for (const variant of [
      "machine_start",
      "machine_end_beep",
      "machine_end_silence",
      "machine_end_other"
    ]) {
      const { deps: d, session } = deps(true);
      await handleHttpRequest(
        answerReq("voice.example.com", { CallSid: "CA1", AnsweredBy: variant }),
        d
      );
      expect(session.answeredBy).toBe("machine");
    }
  });

  it("maps fax and unknown through unchanged", async () => {
    for (const variant of ["fax", "unknown"] as const) {
      const { deps: d, session } = deps(true);
      await handleHttpRequest(
        answerReq("voice.example.com", { CallSid: "CA1", AnsweredBy: variant }),
        d
      );
      expect(session.answeredBy).toBe(variant);
    }
  });

  it("leaves answeredBy undefined when AMD was not enabled", async () => {
    const { deps: d, session } = deps(true);
    await handleHttpRequest(answerReq("voice.example.com", { CallSid: "CA1" }), d);
    expect(session.answeredBy).toBeUndefined();
  });

  it("treats an unrecognised AnsweredBy value as unknown rather than trusting it", async () => {
    const { deps: d, session } = deps(true);
    await handleHttpRequest(
      answerReq("voice.example.com", { CallSid: "CA1", AnsweredBy: "something_new" }),
      d
    );
    expect(session.answeredBy).toBe("unknown");
  });
});

describe("origination wires the status callback", () => {
  it("passes a status callback URL derived from the public host", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const t = { ...telephony(true), originate };
    const { deps: d } = deps(true);
    await handleHttpRequest(
      {
        method: "POST",
        path: "/call",
        query: "",
        headers: {
          authorization: "Bearer unused-by-the-status-route",
          "content-type": "application/json"
        },
        rawBody: JSON.stringify({
          version: 2,
          brief: { to: "+14155550002", persona: "p", objective: "o", facts: [] },
          guardrails: ["Be brief."]
        })
      },
      { ...d, telephony: t }
    );
    expect(originate).toHaveBeenCalledWith(
      expect.objectContaining({ statusCallbackUrl: "https://voice.example.com/twilio/status" })
    );
  });
});

describe("end-to-end envelope plumbing", () => {
  async function callWith(envelope: unknown, telephonyOverride?: Partial<TelephonyProvider>) {
    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const t = { ...telephony(true), originate, ...telephonyOverride };
    const { deps: d } = deps(true);
    // Capture what the server hands CallSession by wrapping the class.
    const spy = vi.spyOn(CallSession.prototype, "originate");
    const res = await handleHttpRequest(
      {
        method: "POST",
        path: "/call",
        query: "",
        headers: {
          authorization: "Bearer unused-by-the-status-route",
          "content-type": "application/json"
        },
        rawBody: JSON.stringify(envelope)
      },
      { ...d, telephony: t }
    );
    const captured = (
      spy.mock.instances[0] as unknown as { params: ConstructorParameters<typeof CallSession>[0] }
    )?.params;
    spy.mockRestore();
    return {
      status: res.status,
      body: res.body,
      params: captured,
      originateCalls: originate.mock.calls.length
    };
  }

  const brief = { to: "+14155550002", persona: "p", objective: "o", facts: [] };
  const policy = {
    principalName: "Alex Rivera",
    identity: { style: "silent" as const },
    disclosure: { honestIfAsked: true, volunteer: false },
    scope: { lock: true },
    grounding: { antiInvention: false },
    deferral: { enabled: true },
    authority: {}
  };

  it("passes brief.preferences into composePolicy", async () => {
    const r = await callWith({
      version: 2,
      brief: { ...brief, preferences: ["Prefers morning appointments."] },
      policy
    });
    expect(r.status).toBe(202);
    expect((r.params?.guardrails ?? []).join(" ")).toContain("Prefers morning appointments.");
  });

  it("passes the execution block through to the session", async () => {
    const r = await callWith({
      version: 2,
      brief,
      policy,
      execution: { limits: { maxDurationSeconds: 600 } }
    });
    expect(r.params?.execution?.limits?.maxDurationSeconds).toBe(600);
  });

  it("rejects an incoherent envelope with 400 before originating", async () => {
    const r = await callWith({
      version: 2,
      brief,
      policy: { ...policy, ivr: { goal: "service" } }
    });
    expect(r.status).toBe(400);
    expect(r.originateCalls).toBe(0);
  });

  it("a v1 envelope still works and carries no execution plane", async () => {
    const r = await callWith({ version: 1, brief, policy });
    expect(r.status).toBe(202);
    expect(r.params?.execution).toBeUndefined();
  });
});

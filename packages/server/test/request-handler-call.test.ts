import { describe, expect, it, vi } from "vitest";
import { CallSession, type AudioCodec, type Brief, type RealtimeProvider, type TelephonyProvider } from "@parley/core";
import { representedCall } from "@parley/policy";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { PendingSessions } from "../src/pending-sessions.js";
import { handleHttpRequest, type HttpRequest, type ServerDeps } from "../src/request-handler.js";

const codec: AudioCodec = { decodeInbound: (f) => f, encodeOutbound: (f) => f };
const realtime: RealtimeProvider = { name: "fake", connect: vi.fn() };

function fakeTelephony(originateSpy = vi.fn(async () => ({ providerCallId: "CA777", status: "queued" as const }))): TelephonyProvider {
  return {
    name: "fake",
    originate: originateSpy,
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: () => ({ sendOutboundAudio: () => {}, clearOutboundBuffer: () => {}, close: () => {} }),
    sendDtmf: async () => {},
    hangup: async () => {}
  };
}

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    telephony: fakeTelephony(),
    realtime,
    codec,
    from: "+14155550001",
    publicHost: "voice.example.com",
    model: "gemini-3.1-flash-live-preview",
    numberAllowlist: createNumberAllowlist(["+14155550002"]),
    hostAllowlist: createHostAllowlist(["voice.example.com"]),
    pending: new PendingSessions(),
    ...overrides
  };
}

const brief: Brief = {
  to: "+14155550002",
  persona: "I am Alex Rivera's assistant.", objective: "Confirm the reservation.", facts: ["Party of four at 7pm."]
};

const policy = representedCall({ principalName: "Alex Rivera", callbackNumber: "+15551234567" });

function callReq(body: unknown): HttpRequest {
  return { method: "POST", path: "/call", query: "", headers: { "content-type": "application/json" }, rawBody: JSON.stringify(body) };
}

describe("handleHttpRequest POST /call", () => {
  it("originates and registers the session, returning 202 + callId", async () => {
    const d = deps();
    const res = await handleHttpRequest(callReq({ version: 1, brief, policy }), d);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ callId: "CA777" });
    expect(d.pending.get("CA777")).toBeInstanceOf(CallSession);
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
    const res = await handleHttpRequest(callReq({ version: 1, brief, policy, guardrails: ["x"] }), deps());
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
    const res = await handleHttpRequest(callReq({ version: 1, brief: { ...brief, to: "+19998887777" }, policy }), d);
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

  it("rejects a malformed body with 400", async () => {
    const res = await handleHttpRequest({ ...callReq({}), rawBody: "{bad" }, deps());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  it("rejects an envelope with the wrong version with 400", async () => {
    const res = await handleHttpRequest(callReq({ version: 2, brief, policy }), deps());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  it("rejects an envelope with an unknown top-level field with 400", async () => {
    const res = await handleHttpRequest(callReq({ version: 1, brief, policy, extra: "nope" }), deps());
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
  });

  it("404s an unknown route", async () => {
    const res = await handleHttpRequest({ method: "GET", path: "/nope", query: "", headers: {}, rawBody: "" }, deps());
    expect(res.status).toBe(404);
  });

  it("200s /healthz", async () => {
    const res = await handleHttpRequest({ method: "GET", path: "/healthz", query: "", headers: {}, rawBody: "" }, deps());
    expect(res.status).toBe(200);
  });
});

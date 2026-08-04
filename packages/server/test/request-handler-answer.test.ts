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

const codec: AudioCodec = { decodeInbound: (f) => f, encodeOutbound: (f) => f };
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
      close: () => {}
    }),
    sendDtmf: async () => {},
    hangup: async () => {}
  };
}

function deps(verify: boolean): ServerDeps {
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
    telephony: t,
    realtime,
    codec,
    from: "+14155550001",
    publicHost: "voice.example.com",
    model: "m",
    numberAllowlist: createNumberAllowlist(["+14155550002"]),
    hostAllowlist: createHostAllowlist(["voice.example.com"]),
    pending
  };
}

function answerReq(host: string, sig: string): HttpRequest {
  return {
    method: "POST",
    path: "/twilio/answer",
    query: "",
    headers: {
      host,
      "x-twilio-signature": sig,
      "content-type": "application/x-www-form-urlencoded"
    },
    rawBody: new URLSearchParams({ CallSid: "CA1" }).toString()
  };
}

describe("handleHttpRequest POST /twilio/answer", () => {
  it("returns TwiML pointing at the per-call media URL when the signature verifies", async () => {
    const res = await handleHttpRequest(answerReq("voice.example.com", "ok"), deps(true));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/xml");
    expect(res.body).toContain('<Stream url="wss://voice.example.com/media/CA1"');
  });

  it("rejects a bad signature with 403 (fail closed)", async () => {
    const res = await handleHttpRequest(answerReq("voice.example.com", "bad"), deps(false));
    expect(res.status).toBe(403);
    expect(res.body).toBe("bad signature");
  });

  it("rejects a host not in the allowlist with 403 (SSRF-safe)", async () => {
    const res = await handleHttpRequest(answerReq("attacker.example.com", "ok"), deps(true));
    expect(res.status).toBe(403);
    expect(res.body).toBe("forbidden host");
  });

  it("404s when no pending session matches the CallSid", async () => {
    const d = deps(true);
    d.pending.delete("CA1");
    const res = await handleHttpRequest(answerReq("voice.example.com", "ok"), d);
    expect(res.status).toBe(404);
  });
});

/**
 * POST /call originates a real, billed phone call. Until 2026-08-17 it had no
 * authentication at all: the route table was /healthz, /call, /twilio/answer,
 * 404, and handleCall's only gate was the callable-number allowlist.
 *
 * That was not merely a LAN exposure. The daemon bound `::` (server.ts passed
 * the callback where listen()'s host argument belongs), and the cloudflared
 * ingress maps a whole public hostname to it — verified 2026-08-17,
 * `GET https://<host>/healthz` answered 200 from the public internet with no
 * Cloudflare Access challenge. So anyone who could reach the hostname could
 * have Gemini speak an attacker-authored persona, objective and facts to the
 * allowlisted number, from the operator's Twilio number, on their bill.
 *
 * Two controls, both fail-closed, because they fail closed in different ways:
 *   - the bind (server.test.ts) removes the LAN path
 *   - this token removes the tunnel path, which the bind cannot reach
 * The token is therefore the PRIMARY control, not defence in depth.
 *
 * THE TEST THAT MATTERS MOST is `an unconfigured token denies every call`.
 * A missing secret must never read as "no authentication required" — that is
 * the shape of most auth bypasses, and it is the shape this file exists to
 * make impossible.
 */
import { describe, expect, it, vi } from "vitest";
import type { AudioCodec, Brief, RealtimeProvider, TelephonyProvider } from "@parley/core";
import { representedCall } from "@parley/policy";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { PendingSessions } from "../src/pending-sessions.js";
import { handleHttpRequest, type HttpRequest, type ServerDeps } from "../src/request-handler.js";

const TOKEN = "s3cr3t-token-value";

const codec: AudioCodec = {
  decodeInbound: (f) => f,
  encodeOutbound: (f) => f,
  dtmfTones: () => ({ encoding: "mulaw8k", data: Buffer.alloc(0) })
};
const realtime: RealtimeProvider = { name: "fake", connect: vi.fn() };

function fakeTelephony(
  originateSpy = vi.fn(async () => ({ providerCallId: "CA777", status: "queued" as const }))
): TelephonyProvider {
  return {
    name: "fake",
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
    callToken: TOKEN,
    ...overrides
  };
}

const brief: Brief = {
  to: "+14155550002",
  persona: "I am Alex Rivera's assistant.",
  objective: "Confirm the reservation.",
  facts: ["Party of four at 7pm."]
};
const policy = representedCall({ principalName: "Alex Rivera", callbackNumber: "+15551234567" });
const body = { version: 1, brief, policy };

function callReq(headers: Record<string, string> = {}, payload: unknown = body): HttpRequest {
  return {
    method: "POST",
    path: "/call",
    query: "",
    headers: { "content-type": "application/json", ...headers },
    rawBody: JSON.stringify(payload)
  };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("POST /call authentication", () => {
  it("accepts a correct bearer token", async () => {
    const res = await handleHttpRequest(callReq(bearer(TOKEN)), deps());
    expect(res.status).toBe(202);
  });

  it("an unconfigured token denies every call, rather than allowing them", async () => {
    // The whole point. An operator who forgets to set PARLEY_CALL_TOKEN must
    // get a daemon that refuses to dial, never one that dials for anybody.
    for (const callToken of [undefined, "", "   "]) {
      const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
      const d = deps({ callToken, telephony: fakeTelephony(originate) });
      const res = await handleHttpRequest(callReq(bearer(TOKEN)), d);
      expect(res.status, `callToken=${JSON.stringify(callToken)}`).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: "call authentication is not configured" });
      expect(originate).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing Authorization header with 401 and does not originate", async () => {
    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const d = deps({ telephony: fakeTelephony(originate) });
    const res = await handleHttpRequest(callReq(), d);
    expect(res.status).toBe(401);
    expect(originate).not.toHaveBeenCalled();
  });

  it("rejects a wrong token of the same length with 401", async () => {
    // Same length as TOKEN, so a length check alone cannot be what rejects it.
    const wrong = "X".repeat(TOKEN.length);
    const res = await handleHttpRequest(callReq(bearer(wrong)), deps());
    expect(res.status).toBe(401);
  });

  it.each([
    ["no scheme", TOKEN],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["lowercase scheme", `bearer ${TOKEN}`],
    ["token prefix only", `Bearer ${TOKEN.slice(0, 5)}`],
    ["token with trailing junk", `Bearer ${TOKEN}x`],
    ["empty bearer", "Bearer "]
  ])("rejects %s", async (_label, header) => {
    const res = await handleHttpRequest(callReq({ authorization: header }), deps());
    // `bearer` lowercase is accepted (RFC 7235 makes the scheme case-insensitive);
    // everything else is a 401.
    expect(header === `bearer ${TOKEN}` ? 202 : 401).toBe(res.status);
  });

  it("authenticates BEFORE parsing the envelope, so an anonymous caller learns nothing", async () => {
    // Ordering is a real property: if parsing ran first, the 400/403 responses
    // would let an unauthenticated prober distinguish a valid envelope shape
    // and enumerate the callable-number allowlist.
    const malformed = await handleHttpRequest({ ...callReq(), rawBody: "{bad" }, deps());
    expect(malformed.status).toBe(401);

    const originate = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const }));
    const unlisted = await handleHttpRequest(
      callReq({}, { version: 1, brief: { ...brief, to: "+19998887777" }, policy }),
      deps({ telephony: fakeTelephony(originate) })
    );
    expect(unlisted.status).toBe(401);
    expect(originate).not.toHaveBeenCalled();
  });

  it("does not leak the expected token in any response body", async () => {
    for (const res of [
      await handleHttpRequest(callReq(), deps()),
      await handleHttpRequest(callReq(bearer("nope")), deps()),
      await handleHttpRequest(callReq(bearer(TOKEN)), deps({ callToken: undefined }))
    ]) {
      expect(res.body).not.toContain(TOKEN);
    }
  });
});

describe("the other routes are deliberately NOT token-gated", () => {
  it("/twilio/answer does not require the token — Twilio cannot send one", async () => {
    // It has its own control: verifyWebhookSignature. Requiring the bearer here
    // would break inbound answer webhooks entirely.
    const res = await handleHttpRequest(
      {
        method: "POST",
        path: "/twilio/answer",
        query: "callId=CA777",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        rawBody: "CallSid=CA777"
      },
      deps()
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });

  it("/healthz stays open so the tunnel and monitors can probe it", async () => {
    const res = await handleHttpRequest(
      { method: "GET", path: "/healthz", query: "", headers: {}, rawBody: "" },
      deps()
    );
    expect(res.status).toBe(200);
  });

  it("an unknown route still 404s and is not turned into a 401", async () => {
    const res = await handleHttpRequest(
      { method: "GET", path: "/nope", query: "", headers: {}, rawBody: "" },
      deps()
    );
    expect(res.status).toBe(404);
  });
});

import { describe, expect, it, vi } from "vitest";
import { MULAW_8K } from "@parley/core";
import { TwilioTelephonyProvider } from "../src/twilio-telephony-provider.js";

function makeProvider(fetchImpl: typeof fetch) {
  return new TwilioTelephonyProvider({
    accountSid: "AC123",
    authToken: "tok",
    apiBase: "https://api.twilio.test",
    fetchImpl
  });
}

describe("TwilioTelephonyProvider.mediaEncoding", () => {
  it("declares mulaw@8000, readable before any call exists", () => {
    const provider = makeProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.mediaEncoding).toEqual(MULAW_8K);
  });
});

describe("TwilioTelephonyProvider.originate", () => {
  it("POSTs to the Calls endpoint with Basic auth and maps the result", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ sid: "CA999", status: "queued" }), { status: 201 })
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const result = await provider.originate({
      to: "+14155550002",
      from: "+14155550001",
      answerWebhookUrl: "https://voice.example.com/twilio/answer",
      statusCallbackUrl: "https://voice.example.com/twilio/status"
    });
    expect(result).toEqual({ providerCallId: "CA999", status: "queued" });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.twilio.test/2010-04-01/Accounts/AC123/Calls.json");
    expect((init as RequestInit).method).toBe("POST");
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe("Basic " + Buffer.from("AC123:tok").toString("base64"));
    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get("To")).toBe("+14155550002");
    expect(body.get("From")).toBe("+14155550001");
    expect(body.get("Url")).toBe("https://voice.example.com/twilio/answer");
    expect(body.get("StatusCallback")).toBe("https://voice.example.com/twilio/status");
  });

  it("maps a failed origination to status failed", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 400 })
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const result = await provider.originate({
      to: "+1",
      from: "+1",
      answerWebhookUrl: "https://h/a"
    });
    expect(result.status).toBe("failed");
  });
});

describe("TwilioTelephonyProvider.buildAnswerResponse", () => {
  it("returns text/xml TwiML for the media URL", () => {
    const provider = makeProvider((async () => new Response()) as unknown as typeof fetch);
    const res = provider.buildAnswerResponse({
      callId: "CA1",
      mediaStreamUrl: "wss://h/media/CA1"
    });
    expect(res.contentType).toBe("text/xml");
    expect(res.body).toContain('<Stream url="wss://h/media/CA1"');
  });
});

describe("TwilioTelephonyProvider.verifyWebhookSignature", () => {
  it("delegates to verifyTwilioSignature using the provider's auth token", () => {
    const provider = makeProvider((async () => new Response()) as unknown as typeof fetch);
    const req = {
      headers: { "x-twilio-signature": "wrong" },
      rawBody: "CallSid=CA1",
      fullUrl: "https://h/a"
    };
    expect(provider.verifyWebhookSignature(req)).toBe(false);
  });
});

describe("TwilioTelephonyProvider.hangup", () => {
  it("POSTs Status=completed to the call resource", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 })
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await provider.hangup("CA999");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.twilio.test/2010-04-01/Accounts/AC123/Calls/CA999.json");
    expect(new URLSearchParams((init as RequestInit).body as string).get("Status")).toBe(
      "completed"
    );
  });
});

describe("TwilioTelephonyProvider.originate — lifecycle wiring", () => {
  async function capturedOriginate(extra: Record<string, unknown>) {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ sid: "CA999", status: "queued" }), { status: 201 })
    ) as unknown as typeof fetch;
    await makeProvider(fetchImpl).originate({
      to: "+14155550002",
      from: "+14155550001",
      answerWebhookUrl: "https://voice.example.com/twilio/answer",
      ...extra
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    return new URLSearchParams((init as RequestInit).body as string);
  }

  it("sends the four status events when a status URL is given", async () => {
    const body = await capturedOriginate({
      statusCallbackUrl: "https://voice.example.com/twilio/status"
    });
    expect(body.get("StatusCallback")).toBe("https://voice.example.com/twilio/status");
    expect(body.get("StatusCallbackEvent")).toBe("initiated ringing answered completed");
  });

  it("sends no status event list when no status URL is given", async () => {
    const body = await capturedOriginate({});
    expect(body.get("StatusCallback")).toBeNull();
    expect(body.get("StatusCallbackEvent")).toBeNull();
  });

  it("omits MachineDetection unless asked for", async () => {
    expect((await capturedOriginate({})).get("MachineDetection")).toBeNull();
  });

  it("sends MachineDetection when asked for", async () => {
    expect((await capturedOriginate({ machineDetection: "Enable" })).get("MachineDetection")).toBe(
      "Enable"
    );
    expect(
      (await capturedOriginate({ machineDetection: "DetectMessageEnd" })).get("MachineDetection")
    ).toBe("DetectMessageEnd");
  });

  it("omits SendDigits unless asked for", async () => {
    expect((await capturedOriginate({})).get("SendDigits")).toBeNull();
  });

  it("sends SendDigits when asked for", async () => {
    expect((await capturedOriginate({ sendDigits: "1234w5678#" })).get("SendDigits")).toBe(
      "1234w5678#"
    );
  });
});

// SendDigits at origination (design: Twilio plays these itself, out-of-band,
// after the call is answered — before any media stream or TwiML exists, and
// so incapable of the redirect-a-live-call failure `hangup`'s doc comment
// above describes for a provider-side sendDtmf). Deterministic entry into a
// bridge whose prompts are known in advance, as distinct from the model's
// in-band `press_digits`, which exists for menus the model must listen to and
// react to live. This does not reverse that decision — it adds a parameter
// to the ORIGINATION request, before the call is even dialled, not a
// mid-call REST action against a live call.
describe("TwilioTelephonyProvider.originate — SendDigits validation", () => {
  function provider() {
    return makeProvider(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ sid: "CA999", status: "queued" }), { status: 201 })
      ) as unknown as typeof fetch
    );
  }

  it("accepts the full alphabet: 0-9, *, #, w, W", async () => {
    await expect(
      provider().originate({
        to: "+1",
        from: "+1",
        answerWebhookUrl: "https://h/a",
        sendDigits: "0123456789*#wW"
      })
    ).resolves.toBeDefined();
  });

  it("rejects an empty sendDigits before ever calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const p = makeProvider(fetchImpl);
    await expect(
      p.originate({ to: "+1", from: "+1", answerWebhookUrl: "https://h/a", sendDigits: "" })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a character outside the alphabet before ever calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const p = makeProvider(fetchImpl);
    await expect(
      p.originate({
        to: "+1",
        from: "+1",
        answerWebhookUrl: "https://h/a",
        sendDigits: "1234x5678"
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects sendDigits over the assumed 32-character ceiling before ever calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const p = makeProvider(fetchImpl);
    await expect(
      p.originate({
        to: "+1",
        from: "+1",
        answerWebhookUrl: "https://h/a",
        sendDigits: "1".repeat(33)
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts sendDigits at exactly the 32-character ceiling", async () => {
    await expect(
      provider().originate({
        to: "+1",
        from: "+1",
        answerWebhookUrl: "https://h/a",
        sendDigits: "1".repeat(32)
      })
    ).resolves.toBeDefined();
  });

  // sendDigits typically carries a bridge passcode (design doc: "Treat it as
  // a secret"). A thrown validation error is a surface this codebase does not
  // otherwise guard with redaction — request-handler.ts's catch around
  // parseCallEnvelope discards the error entirely, but nothing stops a FUTURE
  // caller of this provider from logging a caught error's `.message` — so the
  // message itself must never carry the value, not merely rely on nobody
  // printing it.
  it("does not echo the invalid value into the thrown error", async () => {
    const p = makeProvider(vi.fn() as unknown as typeof fetch);
    try {
      await p.originate({
        to: "+1",
        from: "+1",
        answerWebhookUrl: "https://h/a",
        sendDigits: "9999secretpasscode9999"
      });
      expect.unreachable("expected originate to reject");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secretpasscode");
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { TwilioTelephonyProvider } from "../src/twilio-telephony-provider.js";

function makeProvider(fetchImpl: typeof fetch) {
  return new TwilioTelephonyProvider({
    accountSid: "AC123",
    authToken: "tok",
    apiBase: "https://api.twilio.test",
    fetchImpl
  });
}

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

import { describe, expect, it } from "vitest";
import { MULAW_8K, PCM_16K, PCM_24K } from "../src/types.js";
import type {
  AudioFrame,
  MediaStreamHandle,
  RealtimeProvider,
  RealtimeSession,
  TelephonyProvider
} from "../src/types.js";

describe("TelephonyProvider interface shape", () => {
  it("a conforming fixture object satisfies the interface", async () => {
    const fixture: TelephonyProvider = {
      name: "fixture-telephony",
      mediaEncoding: MULAW_8K,
      originate: async () => ({ providerCallId: "CA123", status: "queued" }),
      buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
      verifyWebhookSignature: () => false,
      attachMediaStream: (): MediaStreamHandle => ({
        sendOutboundAudio: () => {},
        clearOutboundBuffer: () => {},
        drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
        close: () => {}
      }),
      hangup: async () => {}
    };

    expect(fixture.name).toBe("fixture-telephony");
    expect(
      await fixture.originate({
        to: "+14155551234",
        from: "+14155559999",
        answerWebhookUrl: "https://example.com"
      })
    ).toEqual({
      providerCallId: "CA123",
      status: "queued"
    });
    expect(
      fixture.verifyWebhookSignature({ headers: {}, rawBody: "", fullUrl: "https://example.com" })
    ).toBe(false);
  });
});

describe("RealtimeProvider interface shape", () => {
  it("a conforming fixture object satisfies the interface", async () => {
    const audioFrame: AudioFrame = { encoding: PCM_16K, data: Buffer.from([]) };
    const fixture: RealtimeProvider = {
      name: "fixture-realtime",
      audio: { accepts: [PCM_16K], emits: PCM_24K },
      openingDelivery: "turn",
      continuesAfterToolResponse: false,
      connect: async (): Promise<RealtimeSession> => ({
        sendOpeningTrigger: () => {},
        sendAudio: () => {},
        notifyActivityEnd: () => {},
        sendToolResponse: () => {},
        close: async () => {}
      })
    };

    const session = await fixture.connect({
      model: "gemini-3.1-flash-live-preview",
      systemInstruction: "You are a test persona.",
      responseModality: "audio",
      callbacks: {
        onAudio: () => {},
        onInterrupted: () => {},
        onTranscript: () => {},
        onError: () => {},
        onClose: () => {}
      }
    });

    session.sendOpeningTrigger("Begin the call naturally now.");
    session.sendAudio(audioFrame);
    session.notifyActivityEnd();
    await session.close();

    expect(fixture.name).toBe("fixture-realtime");
  });
});

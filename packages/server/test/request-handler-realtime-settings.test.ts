import { describe, expect, it } from "vitest";
import {
  MULAW_8K,
  type AudioCodec,
  type FrameConverter,
  type RealtimeConnectParams,
  type RealtimeProvider,
  type TelephonyProvider,
  type WebSocketLike
} from "@parley/core";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { handleMediaConnection, type CompletedCallRecord } from "../src/media-connection.js";
import { PendingSessions } from "../src/pending-sessions.js";
import { handleHttpRequest, type ServerDeps } from "../src/request-handler.js";

/** Per-call realtime settings (`execution.realtime.think/voice/speed/
 * expressivity`). The schema checks shape; membership — is this a model or a
 * voice the chosen provider has — is checked HERE, before anything is reserved
 * or dialled, against the lists each provider package exports. What reaches
 * the provider's `connect` and what the record says ran are both checked end
 * to end, through POST /call and the media connection. */

const convert: FrameConverter = (f, to) => ({ encoding: to, data: f.data });
const canConvert = (): boolean => true;
const codec: AudioCodec = { dtmfTones: () => ({ encoding: MULAW_8K, data: Buffer.alloc(0) }) };
const TOKEN = "test-call-token";

function rig(name: string) {
  const seen: { params?: RealtimeConnectParams } = {};
  const provider: RealtimeProvider = {
    name,
    audio: { accepts: [MULAW_8K], emits: MULAW_8K },
    openingDelivery: "turn",
    continuesAfterToolResponse: false,
    connect: async (params) => {
      seen.params = params;
      return {
        sendOpeningTrigger: () => {},
        sendAudio: () => {},
        sendToolResponse: () => {},
        notifyActivityEnd: () => {},
        close: async () => {}
      };
    }
  };
  return { provider, seen };
}

function telephony(): TelephonyProvider {
  return {
    name: "fake",
    mediaEncoding: MULAW_8K,
    originate: async () => ({ providerCallId: "CA-RS-1", status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "" }),
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

function fakeSocket(): WebSocketLike & { triggerClose: () => void } {
  const closeListeners: Array<(...args: unknown[]) => void> = [];
  return {
    send: () => {},
    on(event, listener) {
      if (event === "close") closeListeners.push(listener);
    },
    close() {},
    triggerClose() {
      for (const listener of closeListeners) listener();
    }
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup() {
  const gemini = rig("gemini");
  const deepgram = rig("deepgram");
  const pending = new PendingSessions();
  const deps: ServerDeps = {
    telephony: telephony(),
    realtime: {
      providers: {
        gemini: { provider: gemini.provider, model: "gemini-3.8-live" },
        deepgram: { provider: deepgram.provider, model: "gpt-4o-mini" }
      },
      default: "gemini"
    },
    codec,
    convert,
    canConvert,
    from: "+14155550001",
    publicHost: "voice.example.com",
    numberAllowlist: createNumberAllowlist(["+14155550002"]),
    hostAllowlist: createHostAllowlist(["voice.example.com"]),
    pending,
    callToken: TOKEN,
    meetingArtifactsConfigured: true
  };
  return { gemini, deepgram, pending, deps };
}

function post(deps: ServerDeps, realtime?: unknown) {
  return handleHttpRequest(
    {
      method: "POST",
      path: "/call",
      query: "",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      rawBody: JSON.stringify({
        version: 2,
        brief: { to: "+14155550002", persona: "p", objective: "o", facts: [] },
        guardrails: ["Be brief."],
        ...(realtime !== undefined ? { execution: { realtime } } : {})
      })
    },
    deps
  );
}

/** Answer the call (which connects the realtime session), then hang it up and
 * return the completed-call record. */
async function runCall(pending: PendingSessions): Promise<CompletedCallRecord> {
  const socket = fakeSocket();
  const records: CompletedCallRecord[] = [];
  await handleMediaConnection("CA-RS-1", socket, {
    pending,
    onCallCompleted: (r) => {
      records.push(r);
    }
  });
  socket.triggerClose();
  await settle();
  expect(records).toHaveLength(1);
  return records[0]!;
}

describe("POST /call — per-call realtime settings", () => {
  it("passes a Deepgram think model and speed to connect, and records the effective values", async () => {
    const { deepgram, pending, deps } = setup();
    const res = await post(deps, { provider: "deepgram", think: "claude-haiku-4-5", speed: 1.1 });
    expect(res.status).toBe(202);
    const record = await runCall(pending);
    expect(deepgram.seen.params?.settings).toEqual({
      think: { provider: "anthropic", model: "claude-haiku-4-5" },
      speed: 1.1
    });
    expect(record.realtime).toEqual({
      provider: "deepgram",
      model: "claude-haiku-4-5",
      speed: 1.1
    });
  });

  it("passes a Deepgram voice and expressivity, and records them", async () => {
    const { deepgram, pending, deps } = setup();
    const res = await post(deps, { provider: "deepgram", voice: "flux-kit-en", expressivity: 2 });
    expect(res.status).toBe(202);
    const record = await runCall(pending);
    expect(deepgram.seen.params?.voice).toBe("flux-kit-en");
    expect(deepgram.seen.params?.settings).toEqual({ expressivity: 2 });
    expect(record.realtime).toEqual({
      provider: "deepgram",
      model: "gpt-4o-mini",
      voice: "flux-kit-en",
      expressivity: 2
    });
  });

  it("passes a Gemini voice to connect", async () => {
    const { gemini, pending, deps } = setup();
    const res = await post(deps, { provider: "gemini", voice: "Puck" });
    expect(res.status).toBe(202);
    const record = await runCall(pending);
    expect(gemini.seen.params?.voice).toBe("Puck");
    expect("settings" in gemini.seen.params!).toBe(false);
    expect(record.realtime).toEqual({
      provider: "gemini",
      model: "gemini-3.8-live",
      voice: "Puck"
    });
  });

  it("with no settings, connects and records exactly as before", async () => {
    for (const realtime of [undefined, { provider: "deepgram" }]) {
      const { gemini, deepgram, pending, deps } = setup();
      const res = await post(deps, realtime);
      expect(res.status).toBe(202);
      const record = await runCall(pending);
      const params = (realtime ? deepgram : gemini).seen.params!;
      expect("settings" in params).toBe(false);
      expect("voice" in params).toBe(false);
      expect(params.model).toBe(realtime ? "gpt-4o-mini" : "gemini-3.8-live");
      expect(record.realtime).toEqual(
        realtime
          ? { provider: "deepgram", model: "gpt-4o-mini" }
          : { provider: "gemini", model: "gemini-3.8-live" }
      );
    }
  });

  it.each([
    [{ provider: "deepgram", think: "x" }, 'unknown think model "x"'],
    [{ provider: "gemini", think: "gpt-4o-mini" }, "think is not supported by gemini"],
    [{ provider: "gemini", voice: "NotAVoice" }, 'unknown gemini voice "NotAVoice"'],
    [{ provider: "deepgram", voice: "Puck" }, 'unknown deepgram voice "Puck"'],
    [{ provider: "gemini", speed: 1.1 }, "speed is not supported by gemini"],
    [{ provider: "gemini", expressivity: 1 }, "expressivity is not supported by gemini"]
  ])("refuses %j with 400 before dialling", async (realtime, error) => {
    const { pending, deps } = setup();
    const res = await post(deps, realtime);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: error });
    expect(pending.size).toBe(0);
  });

  it("refuses speed 2 with 400, from the schema", async () => {
    const { pending, deps } = setup();
    const res = await post(deps, { provider: "deepgram", speed: 2 });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid call envelope" });
    expect(pending.size).toBe(0);
  });
});

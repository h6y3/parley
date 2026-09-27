import { describe, expect, it } from "vitest";
import {
  CallSession,
  MULAW_8K,
  PCM_16K,
  MIXED_SOURCE,
  type AudioCodec,
  type AudioSource,
  type Brief,
  type RealtimeProvider,
  type TelephonyProvider,
  type WebSocketLike
} from "@parley/core";
import { convert } from "@parley/audio";
import { representedCall, type CallPolicy } from "@parley/policy";
import { createDeepgramTranscriptionProvider } from "@parley/transcription-deepgram";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { handleMediaConnection } from "../src/media-connection.js";
import { PendingSessions } from "../src/pending-sessions.js";
import { handleHttpRequest, type HttpRequest, type ServerDeps } from "../src/request-handler.js";

/**
 * The most important claim in the transcription-wiring fix — "a meeting call
 * through parley serve transcribes end to end" — was verified by hand
 * against `@parley/transcription-deepgram`'s REAL provider and then thrown
 * away (a one-off script in /tmp). Every other committed test uses a fully
 * stubbed `TranscriptionProvider`, which proves the WIRING is correct but
 * says nothing about the real provider's own connect/parse behaviour once
 * wired in. This file commits that verification as a guard, using the exact
 * technique `@parley/transcription-deepgram`'s own
 * `test/provider.test.ts` uses to avoid a real network call: a fake API key
 * and a fake `wsFactory` returning a fake socket — everything else about the
 * provider (its Deepgram query-string construction, its message parsing, its
 * TranscriptEvent shaping) runs unmodified, real code.
 *
 * No network call. No real credential — "test-key-not-real" never resolves
 * to anything and is never sent anywhere but into this fake socket's own
 * `sent` array.
 */

class FakeDeepgramSocket {
  readonly sent: unknown[] = [];
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  on(event: string, fn: (...a: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close", 1000, Buffer.from("done"));
  }
}

/** Real enough for `attachMediaStream` to register against and for
 * `handleMediaConnection`'s eviction path to drive — combines what Task 13's
 * `media-connection.test.ts` fakes (a close-triggerable `WebSocketLike`) with
 * what a telephony provider needs (a registered inbound-audio handler). */
class FakeMediaSocket implements WebSocketLike {
  private closeListeners: Array<(...args: unknown[]) => void> = [];
  private inboundHandler?: (
    frame: { encoding: typeof MULAW_8K; data: Buffer },
    source: AudioSource
  ) => void;
  send(): void {}
  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "close") this.closeListeners.push(listener);
  }
  close(): void {}
  registerInboundHandler(
    handler: (frame: { encoding: typeof MULAW_8K; data: Buffer }, source: AudioSource) => void
  ): void {
    this.inboundHandler = handler;
  }
  pushInbound(frame: { encoding: typeof MULAW_8K; data: Buffer }, source: AudioSource): void {
    this.inboundHandler?.(frame, source);
  }
  triggerClose(): void {
    for (const l of this.closeListeners) l();
  }
}

const codec: AudioCodec = {
  decodeInbound: (f) => ({ encoding: PCM_16K, data: f.data }),
  encodeOutbound: (f) => ({ encoding: MULAW_8K, data: f.data }),
  dtmfTones: () => ({ encoding: MULAW_8K, data: Buffer.alloc(0) })
};
const realtime: RealtimeProvider = {
  name: "fake-realtime",
  connect: async () => ({
    sendOpeningTrigger: () => {},
    sendAudio: () => {},
    sendToolResponse: () => {},
    notifyActivityEnd: () => {},
    close: async () => {}
  })
};

function fakeTelephony(mediaSocketRef: { current?: FakeMediaSocket }): TelephonyProvider {
  return {
    name: "fake-telephony",
    originate: async () => ({ providerCallId: "CA-TRANSCRIBE-1", status: "queued" as const }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: (p) => {
      if (p.socket instanceof FakeMediaSocket) {
        mediaSocketRef.current = p.socket;
        p.socket.registerInboundHandler((frame, source) => p.onInboundAudio(frame, source));
      }
      return {
        sendOutboundAudio: () => {},
        clearOutboundBuffer: () => {},
        drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
        close: () => {}
      };
    },
    hangup: async () => {}
  };
}

const TOKEN = "test-call-token";
const brief: Brief = {
  to: "+14155550002",
  persona: "I am Alex Rivera's assistant.",
  objective: "Confirm the reservation.",
  facts: ["Party of four at 7pm."]
};
// `policy.meeting.announce: true` must be paired with `execution.meeting`
// (Important Finding 1 of this same fix) — an envelope with one and not the
// other is now rejected before it reaches this test's real assertions.
//
// `representedCall`'s `callback`/`wrapUp`/`voicemail` are stripped below:
// once `policy.meeting.announce` is true, the envelope schema now REJECTS all
// three outright — meaningless for a notetaker that goes voiceless the
// instant consent is granted (@parley/policy's schema.ts meeting rejections).
// This file is exactly the "committed fixture pairs meeting with a
// now-rejected field" case that change's design brief warned would exist
// somewhere.
const policy: CallPolicy = {
  ...representedCall({ principalName: "Alex Rivera", callbackNumber: "+15551234567" }),
  meeting: { announce: true, purpose: "take notes for the record" }
};
delete policy.callback;
delete policy.wrapUp;
delete policy.voicemail;
const meetingExecution = {
  meeting: {
    consent: {
      phrase: "go ahead and take notes",
      timeoutSeconds: 180,
      onTimeout: "hangUp" as const
    }
  }
};

function callReq(body: unknown): HttpRequest {
  return {
    method: "POST",
    path: "/call",
    query: "",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    rawBody: JSON.stringify(body)
  };
}

describe("a meeting call transcribes end to end through the REAL Deepgram provider", () => {
  it("connects for real, parses a real Deepgram message, and the resulting transcript reaches the completed-call record", async () => {
    const deepgramSocket = new FakeDeepgramSocket();
    const transcriptionProvider = createDeepgramTranscriptionProvider({
      apiKey: "test-key-not-real",
      wsFactory: () => deepgramSocket as never
    });

    const mediaSocketRef: { current?: FakeMediaSocket } = {};
    const pending = new PendingSessions();
    let completedRecord: { transcript: readonly { text: string }[] } | undefined;
    // `onCallCompleted` lives on `handleMediaConnection`'s own deps, not on
    // `ServerDeps` — `ServerDeps` is `handleHttpRequest`'s parameter and has
    // no notion of it (that wiring only exists one layer up, in
    // `createParleyServer`/`ParleyServerConfig`, which this test does not
    // exercise — it drives the two HTTP-layer functions directly).
    // SNAPSHOT the texts inside the hook. `transcript` is a live reference into
    // CallSession, so a record read afterwards shows entries appended long
    // after the hook already wrote its files — and "the flushed utterance made
    // it into the artifact" is exactly the claim that would then pass over a
    // record that never contained it.
    const onCallCompleted = (record: { transcript: readonly { text: string }[] }): void => {
      completedRecord = { transcript: record.transcript.map((e) => ({ text: e.text })) };
    };

    const deps: ServerDeps = {
      telephony: fakeTelephony(mediaSocketRef),
      realtime,
      codec,
      from: "+14155550001",
      publicHost: "voice.internal.test",
      model: "test-model",
      numberAllowlist: createNumberAllowlist(["+14155550002"]),
      hostAllowlist: createHostAllowlist(["voice.internal.test"]),
      pending,
      callToken: TOKEN,
      meetingArtifactsConfigured: true,
      transcription: { provider: transcriptionProvider, convert }
    };

    // 1) The real POST /call path.
    const callRes = await handleHttpRequest(
      callReq({ version: 2, brief, policy, execution: meetingExecution }),
      deps
    );
    expect(callRes.status).toBe(202);
    const { callId } = JSON.parse(callRes.body) as { callId: string };

    // 2) The real media-WS attach path.
    const mediaSocket = new FakeMediaSocket();
    const ok = await handleMediaConnection(callId, mediaSocket, { pending, onCallCompleted });
    expect(ok).toBe(true);

    const session = pending.get(callId) as CallSession;
    expect(session.isMeeting).toBe(true);

    // 3) Real consent, then the real beginNotetaking() — this is the exact
    // call that threw "no transcription plane declared" before the fix.
    session.noteTranscript({
      speaker: "model",
      text: "I'm an AI assistant sitting in for the host.",
      isFinal: true
    });
    session.noteTranscript({ speaker: "model", text: "Any objection?", isFinal: true });
    session.noteTranscript({ speaker: "caller", text: "go ahead and take notes", isFinal: true });

    const beginPromise = session.beginNotetaking();
    // The real provider's connect() waits on the fake socket's "open" event —
    // matching @parley/transcription-deepgram's own test technique exactly.
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepgramSocket.emit("open");
    await expect(beginPromise).resolves.toBeUndefined();

    // 4) Real audio in; a real Deepgram-shaped message out, parsed by the
    // real provider (not reconstructed by this test).
    mediaSocket.pushInbound({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
    deepgramSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 0.5,
          duration: 1.7,
          is_final: true,
          channel: {
            alternatives: [{ transcript: "let's ship the roadmap as discussed", words: [] }]
          }
        })
      )
    );

    // 5) End the call — the real eviction path in handleMediaConnection, which
    // now tears the session down BEFORE building the record. That runs the real
    // flush: the provider sends Deepgram's `Finalize` marker and WAITS for the
    // Results message it asks for, so the meeting's last utterance lands in the
    // transcript rather than dying with the socket carrying it. Answer it the
    // way Deepgram does, with one more real, unparsed Results payload.
    mediaSocket.triggerClose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deepgramSocket.sent.map(String)).toContain(JSON.stringify({ type: "Finalize" }));
    // Nothing may have been recorded yet — the hangup is still waiting on the
    // vendor, which is the whole point of the bounded wait.
    expect(completedRecord).toBeUndefined();

    deepgramSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          start: 12.0,
          duration: 2.4,
          is_final: true,
          channel: { alternatives: [{ transcript: "one last thing before we go", words: [] }] }
        })
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completedRecord).toBeDefined();
    expect(
      completedRecord?.transcript.some((e) => e.text === "let's ship the roadmap as discussed")
    ).toBe(true);
    // The flushed utterance is in the record, not merely in the session after
    // the record was written.
    expect(completedRecord?.transcript.some((e) => e.text === "one last thing before we go")).toBe(
      true
    );
  });
});

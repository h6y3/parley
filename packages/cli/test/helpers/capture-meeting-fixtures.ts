import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import {
  CallSession,
  MIXED_SOURCE,
  MULAW_8K,
  type AudioCodec,
  type AudioFrame,
  type FrameConverter,
  type AudioSource,
  type MeetingExecution,
  type RealtimeConnectParams,
  type RealtimeProvider,
  type TelephonyProvider,
  type ToolCallRequest,
  type TranscriptionCallbacks,
  type TranscriptionConnectParams,
  type TranscriptionProvider,
  type TranscriptionSession,
  type WebSocketLike
} from "@parley/core";
import { handleMediaConnection, PendingSessions } from "@parley/server";
import { runCompletedCallPostCall } from "../../src/commands.js";
import { meetingTranscriptDir } from "../../src/commands.js";
import { join } from "node:path";

/**
 * CAPTURE the committed meeting fixtures by driving a real meeting through the
 * real production path, rather than hand-writing files that look like what
 * production might emit.
 *
 * The previous fixtures were built by feeding a hand-assembled
 * `CompletedCallRecord` straight into `runCompletedCallPostCall`, and that is
 * one layer too late: every fact about WHICH events end up on a meeting's
 * transcript is decided upstream of that call, in `CallSession`. The result
 * carried the announcement and the go-ahead as timed transcript rows, and
 * production puts both in the volatile pre-consent buffer and never in
 * `transcriptLog` — a fixture teaching A2's author to expect rows that cannot
 * exist, in a file whose README claimed it "reflects exactly what production
 * emits today".
 *
 * So this runs the whole thing: `handleMediaConnection` attaches a real
 * `CallSession`, the model announces and asks through the real realtime
 * callbacks, the room answers, `begin_notetaking` goes through the real
 * `ToolGate`, the handoff happens, carrier frames are pumped through the real
 * sink fan-out (which is what produces `coveredMs` and the gaps), and the
 * socket close runs the real eviction. Only the three vendor edges are stubs.
 *
 * Deterministic: the meeting-relative clock is injected, and `Date` is faked,
 * so the receipt timestamps and the record's `startedAt`/`endedAt` are the same
 * on every run and on every host.
 *
 * NO network call and no credential — the realtime and transcription providers
 * are local stubs, and the telephony provider never leaves the process.
 */

const FRAME_MS = 20;

// The capture realtime stub speaks the carrier's encoding, so the speaking
// plane passes every frame through and this relabelling converter is never
// actually asked to convert. It exists to satisfy the contract.
const convert: FrameConverter = (f, to) => ({ encoding: to, data: f.data });
const canConvert = (): boolean => true;
const codec: AudioCodec = {
  dtmfTones: () => ({ encoding: MULAW_8K, data: Buffer.alloc(0) })
};

class CaptureSocket implements WebSocketLike {
  private closeListeners: Array<() => void> = [];
  private inbound?: (frame: AudioFrame, source: AudioSource) => void;
  send(): void {}
  on(event: string, listener: () => void): void {
    if (event === "close") this.closeListeners.push(listener);
  }
  close(): void {}
  registerInbound(fn: (frame: AudioFrame, source: AudioSource) => void): void {
    this.inbound = fn;
  }
  pushFrame(): void {
    this.inbound?.({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
  }
  triggerClose(): void {
    for (const l of this.closeListeners) l();
  }
}

interface Rig {
  session: CallSession;
  socket: CaptureSocket;
  clock: { t: number; advance(ms: number): void };
  realtime: RealtimeConnectParams["callbacks"];
  listening: { ready: boolean };
  emitTranscription(event: Parameters<TranscriptionCallbacks["onTranscript"]>[0]): void;
  releaseConnect(): void;
}

function rig(
  callId: string,
  epochMs: number,
  meetingBrief?: MeetingExecution["brief"],
  limits?: { maxDurationSeconds: number; maxSilenceSeconds?: number }
): { rig: Rig; pending: PendingSessions } {
  const clock = {
    t: epochMs,
    advance(ms: number) {
      clock.t += ms;
    }
  };
  const socket = new CaptureSocket();

  let realtimeCallbacks!: RealtimeConnectParams["callbacks"];
  const realtime: RealtimeProvider = {
    name: "gemini",
    audio: { accepts: [MULAW_8K], emits: MULAW_8K },
    openingDelivery: "turn",
    continuesAfterToolResponse: false,
    connect: async (p) => {
      realtimeCallbacks = p.callbacks;
      return {
        sendOpeningTrigger: () => {},
        sendAudio: () => {},
        sendToolResponse: () => {},
        notifyActivityEnd: () => {},
        close: async () => {}
      };
    }
  };

  const listening = { ready: true };
  let transcriptionCallbacks: TranscriptionCallbacks | undefined;
  let release: () => void = () => {};
  const listeningSession: TranscriptionSession = {
    get ready() {
      return listening.ready;
    },
    sendAudio: () => {},
    flush: async () => {},
    close: async () => {}
  };
  const transcription = {
    provider: {
      name: "capture-transcription",
      ingress: { audio: true, channels: "mono" as const },
      accepts: [MULAW_8K],
      connect: async (p: TranscriptionConnectParams): Promise<TranscriptionSession> => {
        transcriptionCallbacks = p.callbacks;
        return new Promise<TranscriptionSession>((resolve) => {
          release = () => resolve(listeningSession);
        });
      }
    } satisfies TranscriptionProvider,
    convert: ((f: AudioFrame) => f) as never
  };

  const telephony: TelephonyProvider = {
    name: "capture-telephony",
    mediaEncoding: MULAW_8K,
    originate: async () => ({ providerCallId: callId, status: "queued" }),
    buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
    verifyWebhookSignature: () => true,
    attachMediaStream: (p) => {
      socket.registerInbound((frame, source) => p.onInboundAudio(frame, source));
      return {
        sendOutboundAudio: () => {},
        clearOutboundBuffer: () => {},
        drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
        close: () => {}
      };
    },
    hangup: async () => {}
  };

  const session = new CallSession({
    brief: {
      to: "+15555550142",
      persona: "You are Ada, an assistant.",
      objective: "Take notes on the roadmap sync.",
      facts: []
    },
    guardrails: [],
    telephony,
    realtime,
    codec,
    convert,
    canConvert,
    from: "+15555550123",
    answerWebhookUrl: "https://voice.example.com/twilio/answer",
    model: "gemini-3.8-live",
    now: () => clock.t,
    execution: {
      meeting: {
        consent: {
          phrase: "go ahead and take notes",
          timeoutSeconds: 180,
          onTimeout: "hangUp"
        },
        ...(meetingBrief ? { brief: meetingBrief } : {})
      },
      ...(limits ? { limits } : {})
    },
    transcription
  });

  const pending = new PendingSessions();
  pending.set(callId, session);

  return {
    pending,
    rig: {
      session,
      socket,
      clock,
      get realtime() {
        return realtimeCallbacks;
      },
      listening,
      emitTranscription: (event) => transcriptionCallbacks?.onTranscript(event),
      releaseConnect: () => release()
    } as Rig
  };
}

export interface CapturedMeeting {
  /** transcript.jsonl exactly as `writeTranscriptJsonl` produced it, or null
   * when the meeting never obtained consent and none was written. */
  transcript: string | null;
  /** The record exactly as `buildMeetingRecord` produced it, with
   * `transcriptPath` rewritten to `committedTranscriptPath` — the ONE
   * substitution, because a capture into a scratch directory cannot know the
   * path its own output will be committed at. */
  record: Record<string, unknown>;
}

async function drive(
  callId: string,
  startedAt: string,
  outRoot: string,
  committedTranscriptPath: string | null,
  script: (r: Rig) => Promise<void>,
  meetingBrief?: MeetingExecution["brief"],
  limits?: { maxDurationSeconds: number; maxSilenceSeconds?: number }
): Promise<CapturedMeeting> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(startedAt));
    const { rig: r, pending } = rig(callId, Date.parse(startedAt), meetingBrief, limits);
    const recordsPath = join(outRoot, "calls.jsonl");
    const meetingsDir = join(outRoot, "meetings");
    // Held rather than fire-and-forget: the socket-close listener cannot be
    // awaited from outside, and the artifacts land inside this promise.
    let postCall: Promise<void> | undefined;
    await handleMediaConnection(callId, r.socket, {
      pending,
      onCallCompleted: (record) => {
        postCall = runCompletedCallPostCall({ record, meetingsDir, recordsPath }, {});
        return postCall;
      }
    });
    await script(r);
    r.socket.triggerClose();
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    await postCall;

    // The LAST row: `PARLEY_CALL_RECORDS_PATH` is an append-only JSONL log, so
    // a scratch root shared by two captures holds both.
    const lines = (await readFile(recordsPath, "utf8")).trim().split("\n");
    const line = lines[lines.length - 1] ?? "";
    const record = JSON.parse(line) as Record<string, unknown>;
    const producedPath = record.transcriptPath;
    if (typeof producedPath === "string") {
      if (
        producedPath !==
        join(meetingTranscriptDir(meetingsDir, startedAt, callId), "transcript.jsonl")
      ) {
        throw new Error(`capture: unexpected transcriptPath ${producedPath}`);
      }
      record.transcriptPath = committedTranscriptPath;
      return { transcript: await readFile(producedPath, "utf8"), record };
    }
    return { transcript: null, record };
  } finally {
    vi.useRealTimers();
  }
}

/** Realistic `execution.meeting.brief` for the roadmap-sync capture only —
 * `captureConsentRefused` below deliberately passes none, so the two
 * committed fixtures together show A2's author both shapes: `brief` present
 * (this one) and `brief` entirely absent (the other), rather than only ever
 * demonstrating one. Grounded in this capture's own transcript content
 * (below) rather than invented independently of it. */
const ROADMAP_SYNC_BRIEF: MeetingExecution["brief"] = {
  title: "Roadmap Sync",
  topic: "Q4 scope review — reporting rework and rollout timing.",
  role: "product lead",
  track: ["engineering"]
};

/** The consented meeting: announce, ask, go-ahead, handoff, notes, one hole in
 * the middle where the transcriber dropped out, hang up. */
export async function captureRoadmapSync(
  outRoot: string,
  committedTranscriptPath: string
): Promise<CapturedMeeting> {
  const startedAt = "2026-08-19T17:00:00.000Z";
  return drive(
    "CAfixture0001",
    startedAt,
    outRoot,
    committedTranscriptPath,
    async (r) => {
      const t0 = r.clock.t;
      const at = (ms: number): void => {
        r.clock.t = t0 + ms;
        vi.setSystemTime(new Date(Date.parse(startedAt) + ms));
      };

      // The announcement and the request, in one model turn. Pre-consent, so
      // this reaches the volatile buffer and the consent receipt — never the
      // transcript.
      at(8_000);
      r.realtime.onTranscript({
        speaker: "model",
        text:
          "Hi everyone — I'm an AI assistant on the line for Jordan Rivera, here to take notes. " +
          "Any objection to my doing that?",
        isFinal: true
      });
      r.realtime.onTurnComplete?.();

      // The room answers. Also pre-consent, also buffer-only.
      at(14_000);
      r.realtime.onTranscript({
        speaker: "participant",
        text: "Sure, go ahead and take notes.",
        isFinal: true
      });

      // The model starts its next turn and calls begin_notetaking inside it. The
      // turn completes while the transcriber is still connecting, so it is
      // committed to the transcript — with no timestamps, because the speaking
      // plane reports none. This is the row that used to sort to position 0.
      at(15_000);
      r.realtime.onTranscript({
        speaker: "model",
        text: "Thanks — starting notes now.",
        isFinal: false
      });
      const call: ToolCallRequest = { id: "tc-1", name: "begin_notetaking", args: {} };
      r.realtime.onToolCall?.(call);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      r.realtime.onTurnComplete?.();
      r.releaseConnect();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      // From here the listening plane is the only source of transcript rows, and
      // every carrier frame is either covered or a hole.
      const pump = (untilMs: number): void => {
        while (r.clock.t - t0 + FRAME_MS <= untilMs) {
          r.clock.t += FRAME_MS;
          r.socket.pushFrame();
        }
      };

      pump(21_000);
      r.emitTranscription({
        speaker: "participant",
        segmentId: "21000",
        startMs: 21_000,
        endMs: 27_000,
        text: "So we agreed last week that the Q4 scope drops the reporting rework.",
        isFinal: true
      });
      pump(180_000);
      // The transcriber drops out. Frames are dropped, never buffered, and the
      // drop is recorded as a hole rather than absorbed.
      r.listening.ready = false;
      pump(214_000);
      r.listening.ready = true;
      pump(240_000);
      r.emitTranscription({
        speaker: "participant",
        segmentId: "214500",
        startMs: 214_500,
        endMs: 222_000,
        text: "Ava will send the revised scope doc by Friday and Jordan signs off Monday.",
        isFinal: true
      });
      vi.setSystemTime(new Date(Date.parse(startedAt) + 240_000));
    },
    ROADMAP_SYNC_BRIEF
  );
}

/** The meeting that never got consent: nothing is written but the record, and
 * the record is how anyone learns the promise was kept. */
export async function captureConsentRefused(outRoot: string): Promise<CapturedMeeting> {
  const startedAt = "2026-08-19T17:10:00.000Z";
  return drive("CAfixture0002", startedAt, outRoot, null, async (r) => {
    const t0 = r.clock.t;
    const at = (ms: number): void => {
      r.clock.t = t0 + ms;
      vi.setSystemTime(new Date(Date.parse(startedAt) + ms));
    };
    at(9_000);
    r.realtime.onTranscript({
      speaker: "model",
      text:
        "Hi — I'm an AI assistant on the line for Jordan Rivera, here to take notes. " +
        "Any objection to my doing that?",
      isFinal: true
    });
    r.realtime.onTurnComplete?.();
    at(16_000);
    r.realtime.onTranscript({
      speaker: "participant",
      text: "Actually I'd rather nothing was recorded or transcribed for this one.",
      isFinal: true
    });
    at(45_000);
  });
}

/** `execution.meeting.brief` for the truncated-standup capture — its own
 * distinct content, grounded in this capture's own transcript below, same as
 * `ROADMAP_SYNC_BRIEF` is for that capture. */
const TRUNCATED_STANDUP_BRIEF: MeetingExecution["brief"] = {
  title: "Engineering Standup",
  topic: "Daily standup; blockers on the ingest rewrite.",
  role: "engineering lead",
  track: ["engineering"]
};

/** Wall-clock seconds `execution.limits.maxDurationSeconds` is set to for this
 * capture. `armTimers` (`@parley/core`'s `CallSession`) arms a REAL
 * `setTimeout` for this many real seconds, which this capture never waits
 * out — see the note on `r.session.endCall("durationCap")` below. */
const TRUNCATED_STANDUP_MAX_DURATION_SECONDS = 90;

/** The meeting that runs long: consent granted, two rounds of notes taken,
 * then Parley's own duration ceiling ends it — never the far end. The
 * transcript this produces has no gap row (the transcriber never drops out),
 * so a reader can tell this fixture's truncation banner apart from
 * roadmap-sync's gap banner. */
export async function captureTruncatedStandup(
  outRoot: string,
  committedTranscriptPath: string
): Promise<CapturedMeeting> {
  const startedAt = "2026-08-19T17:20:00.000Z";
  return drive(
    "CAfixture0003",
    startedAt,
    outRoot,
    committedTranscriptPath,
    async (r) => {
      const t0 = r.clock.t;
      const at = (ms: number): void => {
        r.clock.t = t0 + ms;
        vi.setSystemTime(new Date(Date.parse(startedAt) + ms));
      };

      at(7_000);
      r.realtime.onTranscript({
        speaker: "model",
        text:
          "Hi everyone — I'm an AI assistant on the line for Jordan Rivera, here to take notes " +
          "for the standup. Any objection to my doing that?",
        isFinal: true
      });
      r.realtime.onTurnComplete?.();

      at(13_000);
      r.realtime.onTranscript({
        speaker: "participant",
        text: "Sure, go ahead and take notes.",
        isFinal: true
      });

      at(14_000);
      r.realtime.onTranscript({
        speaker: "model",
        text: "Thanks — starting notes now.",
        isFinal: false
      });
      const call: ToolCallRequest = { id: "tc-1", name: "begin_notetaking", args: {} };
      r.realtime.onToolCall?.(call);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      r.realtime.onTurnComplete?.();
      r.releaseConnect();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      const pump = (untilMs: number): void => {
        while (r.clock.t - t0 + FRAME_MS <= untilMs) {
          r.clock.t += FRAME_MS;
          r.socket.pushFrame();
        }
      };

      pump(20_000);
      r.emitTranscription({
        speaker: "participant",
        segmentId: "20000",
        startMs: 20_000,
        endMs: 26_000,
        text: "Quick round — what's everyone blocked on today?",
        isFinal: true
      });
      pump(50_000);
      r.emitTranscription({
        speaker: "participant",
        segmentId: "50000",
        startMs: 50_000,
        endMs: 58_000,
        text: "I'm still waiting on the ingest rewrite review before I can pick up the next ticket.",
        isFinal: true
      });
      pump(TRUNCATED_STANDUP_MAX_DURATION_SECONDS * 1_000);
      vi.setSystemTime(
        new Date(Date.parse(startedAt) + TRUNCATED_STANDUP_MAX_DURATION_SECONDS * 1_000)
      );

      // The cap firing for real, not hand-set: this calls the exact method
      // `armTimers`'s own `setTimeout` calls when it fires
      // (`() => void this.endCall("durationCap")`). The timer itself is real
      // and armed on the session (`execution.limits` below), but it is armed
      // for `TRUNCATED_STANDUP_MAX_DURATION_SECONDS` REAL wall-clock seconds
      // — only `Date` is faked in this capture, not `setTimeout` — so waiting
      // it out here would make every test run take that long. Calling the
      // same method it would have called, at the moment the meeting-relative
      // clock reaches the cap, reaches the identical teardown code
      // (`endCall`'s settled guard, hangup, gap-close, transcription flush)
      // without the wait.
      await r.session.endCall("durationCap");
    },
    TRUNCATED_STANDUP_BRIEF,
    { maxDurationSeconds: TRUNCATED_STANDUP_MAX_DURATION_SECONDS }
  );
}

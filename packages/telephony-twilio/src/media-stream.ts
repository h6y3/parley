import type { AttachMediaStreamParams, AudioFrame, MediaStreamHandle } from "@parley/core";

interface TwilioInbound {
  event: string;
  streamSid?: string;
  start?: { streamSid: string; callSid: string };
  media?: { track?: string; payload: string; timestamp?: string };
}

// Twilio plays outbound audio on a bidirectional <Connect><Stream> at the
// real-time telephony rate and silently DROPS audio delivered faster than real
// time. A native-audio model emits its speech in large, faster-than-real-time
// bursts, so the outbound leg must be PACED: buffer the μ-law and drain it in
// 20 ms / 160-byte frames on a 20 ms cadence, sending μ-law silence while idle
// to keep the stream primed. Matches Twilio's own reference cadence. (This is
// not optional — without it the callee hears nothing. Found at the M3 live
// gate; no offline test exercises Twilio's playout timing.)
const OUTBOUND_FRAME_BYTES = 160; // 20 ms of 8 kHz μ-law
const PACING_INTERVAL_MS = 20;
const MULAW_SILENCE_BYTE = 0xff; // G.711 μ-law encodes PCM zero as 0xFF
// Defensive cap on the outbound backlog (~60 s of 8 kHz μ-law). The queue
// drains at real time (8000 B/s) while the model bursts faster, so a normal
// turn's backlog is bounded by its own length and never approaches this. The
// cap only bites on pathological runaway generation, bounding memory (and
// post-turn drain latency) rather than growing without limit.
const MAX_OUTBOUND_QUEUE_BYTES = 60 * 8000;
// If the pacer falls more than this many frames behind wall-clock (process
// suspended — laptop sleep, long GC), resync instead of bursting a huge backlog
// at Twilio; the audio for that gap is already lost.
const MAX_CATCHUP_FRAMES = 25; // 500 ms

/** How many 20 ms frames should have been emitted by now, given wall-clock time
 * elapsed since pacing began and how many we've already sent. Pure + exported
 * so the catch-up math is unit-testable without fake-timer contortions.
 *
 * Driving frame count off elapsed wall-clock (not off trusting each setInterval
 * tick to fire on time) keeps audio smooth even when the OS delays/coalesces the
 * timer: a late tick simply sends the backlog it owes. `resyncTo`, when set, is
 * the new `framesSent` baseline to jump to after an over-long suspend. */
export function outboundFramesDue(
  elapsedMs: number,
  framesSent: number
): { send: number; resyncTo: number | null } {
  const due = Math.floor(elapsedMs / PACING_INTERVAL_MS) + 1; // +1: emit frame #1 at elapsed 0
  const behind = due - framesSent;
  if (behind <= 0) return { send: 0, resyncTo: null };
  if (behind > MAX_CATCHUP_FRAMES) return { send: 1, resyncTo: due - 1 };
  return { send: behind, resyncTo: null };
}

/** Attach to a Twilio Media Streams WebSocket (design spec §3, §4.5). Twilio
 * sends newline-free JSON text frames: `connected`, `start` (carries the
 * streamSid required on every outbound message), `media` (base64 μ-law 8k),
 * `mark`, `stop`. Outbound audio is paced through a 20 ms frame pacer (see
 * above); barge-in sends `clear`. Operates on the WebSocketLike abstraction so
 * this package needs no `ws` dependency — the server wraps its real socket. */
export function attachTwilioMediaStream(params: AttachMediaStreamParams): MediaStreamHandle {
  const { socket, onInboundAudio, onCallEvent } = params;
  let streamSid: string | undefined;
  let lastTimestampMs = 0;
  let outboundQueue = Buffer.alloc(0);
  const silenceFrame = Buffer.alloc(OUTBOUND_FRAME_BYTES, MULAW_SILENCE_BYTE);

  const sendMedia = (payload: Buffer): void => {
    if (!streamSid) return;
    socket.send(JSON.stringify({ event: "media", streamSid, media: { payload: payload.toString("base64") } }));
  };

  // Emit one 160-byte μ-law frame: queued model audio first, a padded short
  // tail next, silence otherwise — so the outbound cadence never stalls.
  const emitFrame = (): void => {
    if (outboundQueue.length >= OUTBOUND_FRAME_BYTES) {
      sendMedia(outboundQueue.subarray(0, OUTBOUND_FRAME_BYTES));
      outboundQueue = outboundQueue.subarray(OUTBOUND_FRAME_BYTES);
    } else if (outboundQueue.length > 0) {
      const tail = Buffer.concat([outboundQueue, silenceFrame.subarray(0, OUTBOUND_FRAME_BYTES - outboundQueue.length)]);
      outboundQueue = Buffer.alloc(0);
      sendMedia(tail);
    } else {
      sendMedia(silenceFrame);
    }
  };

  // Wall-clock-driven pacer: on each tick, send however many 20 ms frames the
  // elapsed real time owes (not just one), so a delayed/coalesced OS timer never
  // makes audio choppy — it just catches up. Steady state is one frame per tick.
  let pacerEpochMs: number | undefined;
  let framesSent = 0;
  const pacer = setInterval(() => {
    if (!streamSid) return;
    if (pacerEpochMs === undefined) pacerEpochMs = Date.now();
    const { send, resyncTo } = outboundFramesDue(Date.now() - pacerEpochMs, framesSent);
    if (resyncTo !== null) framesSent = resyncTo;
    for (let i = 0; i < send; i++) {
      // Guard each send: a throw from a closing socket must not escape the
      // interval callback (uncaught → would crash the daemon mid-call). The
      // socket's own close handler ends the call cleanly. framesSent still
      // advances so wall-clock accounting stays correct across a transient.
      try {
        emitFrame();
      } catch {
        /* socket send failed (closing) — drop this frame, keep pacing */
      }
      framesSent++;
    }
  }, PACING_INTERVAL_MS);
  if (typeof pacer.unref === "function") pacer.unref();

  socket.on("message", (raw: unknown) => {
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    let msg: TwilioInbound;
    try {
      msg = JSON.parse(text) as TwilioInbound;
    } catch {
      return; // malformed frame — ignore, never throw on hostile input
    }
    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid ?? msg.streamSid;
        onCallEvent({ type: "answered" });
        break;
      case "media":
        // Fallback: every media frame also carries streamSid, so capture it here
        // in case the one-time `start` frame was ever missed (defense in depth).
        streamSid ??= msg.streamSid;
        if (msg.media?.timestamp) lastTimestampMs = Number(msg.media.timestamp) || lastTimestampMs;
        if (msg.media?.payload) {
          onInboundAudio({ encoding: "mulaw8k", data: Buffer.from(msg.media.payload, "base64") });
        }
        break;
      case "stop":
        onCallEvent({ type: "completed", durationSeconds: Math.round(lastTimestampMs / 1000) });
        break;
      default:
        break; // connected, mark, dtmf — not consumed in V1
    }
  });

  return {
    sendOutboundAudio(frame: AudioFrame): void {
      if (frame.encoding !== "mulaw8k") {
        throw new Error(`Twilio media stream expects mulaw8k outbound frames, got ${frame.encoding}`);
      }
      // Enqueue only — the pacer drains it at the real-time telephony rate.
      // Drop the frame if it would blow the runaway-backlog cap (rather than
      // grow memory unbounded); normal turns never reach it.
      if (outboundQueue.length + frame.data.length > MAX_OUTBOUND_QUEUE_BYTES) return;
      outboundQueue = Buffer.concat([outboundQueue, frame.data]);
    },
    clearOutboundBuffer(): void {
      // Barge-in: drop anything not yet paced out AND tell Twilio to flush its
      // own playout buffer, so both layers stop together (design spec §4.5).
      outboundQueue = Buffer.alloc(0);
      if (streamSid) socket.send(JSON.stringify({ event: "clear", streamSid }));
    },
    close(): void {
      clearInterval(pacer);
      socket.close();
    }
  };
}

import type {
  Brief,
  ConsentReceipt,
  EndReason,
  MeetingExecution,
  RecordedOutcome,
  TranscriptEvent,
  TranscriptGap,
  WebSocketLike
} from "@parley/core";
import type { PendingSessions } from "./pending-sessions.js";

export interface CompletedCallRecord {
  callId: string;
  endedAt: string;
  transcript: readonly TranscriptEvent[];
  /** How the call ended. `remote` means the far end hung up; `error` means our
   * own teardown failed. An absent `outcome` alongside `remote` is a caller's
   * signal that the call died before anything was agreed — no prose to parse. */
  endedBy: EndReason;
  answeredBy?: "human" | "machine" | "fax" | "unknown";
  outcome?: RecordedOutcome;
  dtmf?: { pressed: string[]; refused: number };
  /** Whether this call was configured as a meeting at all — see
   * `CallSession.isMeeting`'s own doc. Needed because an ordinary call and a
   * meeting whose consent was refused or timed out are otherwise
   * indistinguishable from the fields below alone (no receipt, no gaps, zero
   * covered ms in both cases). */
  isMeeting: boolean;
  /** Wall-clock anchor for every transcript offset in `transcript` —
   * captured the moment `attach()` was invoked, which is also the instant
   * CallSession's own (private) meeting-relative t0 is set. Present on every
   * record, meeting or not: it costs nothing to capture and an ordinary
   * call's consumer can ignore it. */
  startedAt: string;
  consentReceipt?: ConsentReceipt;
  gaps: readonly TranscriptGap[];
  gapMs: number;
  coveredMs: number;
  /** How many of the model's turns actually completed on this call — present
   * regardless of `isMeeting`, since `CallSession` tracks it for every call.
   * The evidence that the agent was ever given a chance to speak at all: a
   * call that never got past a dial-in IVR ends with this at `0`. Without
   * it, `classifyMeetingOutcome` (`@parley/cli`) cannot tell "we asked for
   * consent and were refused" apart from "we never reached anyone to ask" —
   * see that function's doc comment. */
  modelTurnsCompleted: number;
  /** Passed through verbatim from `CallSession.meetingBrief` — see that
   * getter's doc for why "no meeting" and "meeting, no brief supplied" are
   * indistinguishable here on purpose. `@parley/cli`'s
   * `runCompletedCallPostCall` carries this into `MeetingRecord.brief`
   * unchanged; nothing in this package reads or interprets it. */
  brief?: MeetingExecution["brief"];
  /** Stable caller-owned lineage joining retries of one real-world task. */
  operation?: Brief["operation"];
  /** Declared result fields, allowing consumers to detect a missing outcome. */
  expectedOutcomeFields?: readonly string[];
  /** Which realtime provider spoke on this call, and the model it ran — for
   * Deepgram, the think model. Read from the `CallSession` itself
   * (`CallSession.realtime`), so the record names what actually ran rather
   * than what the daemon's default happened to be. */
  realtime: { provider: string; model: string };
  /** Milliseconds from `startedAt` to the first frame of model audio
   * (`CallSession.firstModelAudioAtMs`) — provider-neutral answer-to-first-word
   * evidence. Absent when the model never spoke, which is a different fact
   * from a slow first word and must not read as one. */
  firstModelAudioMs?: number;
}

/** Correlate an inbound media WebSocket to its pending CallSession by the
 * CallSid carried in the URL path (design spec §3), then attach. Evicts the
 * session from the registry when the socket closes. Returns false (and closes
 * the socket) if no session matches — an unknown/guessed callId gets nothing. */
export async function handleMediaConnection(
  callId: string,
  socket: WebSocketLike,
  deps: {
    pending: PendingSessions;
    onCallCompleted?: (record: CompletedCallRecord) => void | Promise<void>;
  }
): Promise<boolean> {
  const session = deps.pending.get(callId);
  if (!session) {
    socket.close();
    return false;
  }
  let closed = false;
  let stopped = false;
  let handle: Awaited<ReturnType<typeof session.attach>> | undefined = undefined;
  // Captured right before `attach()` is invoked — the same instant
  // CallSession sets its own (private) meeting-relative t0 — rather than
  // added as a new getter on CallSession itself, since nothing outside this
  // function needs it before now.
  let startedAt = "";
  /** Tear the session down, THEN build the record from it, THEN run the hook.
   *
   * The order is the whole point. `endCall` does two things that exist only to
   * make this record honest, and both had already been skipped when the record
   * was built the other way round:
   *
   *  - it seals a gap that is still open (`closeOpenGap`), and an open gap is
   *    one `gaps`/`gapMs` never report — "a hole in the record that the record
   *    does not admit to". A meeting delivered mid-hole read `gaps: [],
   *    gapMs: 0`, which is exactly what a complete meeting reads.
   *  - it flushes the listening plane, "without [which] the last utterance of a
   *    meeting is lost".
   *
   * On the normal meeting ending — the bridge drops the leg, so the media
   * socket closes — that is every meeting, not an edge case.
   *
   * The property the previous ordering was defending is kept: the hook (which
   * writes transcript.jsonl and the meeting record, then spawns
   * PARLEY_POST_CALL_COMMAND) is awaited before this function returns, so
   * nothing races the files it was invoked to read. `handle.stop()` is still
   * invoked SYNCHRONOUSLY on the socket-close tick — it is only the record
   * that now waits. */
  const evict = async (): Promise<void> => {
    deps.pending.delete(callId);
    if (!handle) return;
    if (!stopped) {
      stopped = true;
      // The media socket closing IS the far end going away, so the reason is
      // "remote" — CallSession then skips asking the carrier to hang up a call
      // that is already over.
      try {
        await handle.stop("remote");
      } catch (error) {
        // Guarded so a teardown rejection degrades the record rather than
        // erasing it: everything endCall does before its own last two
        // (unguarded) steps — closeOpenGap, the transcription flush — has
        // already run by the time this can throw, so what's lost here is
        // only the cleanliness of our own hangup, not the call's content.
        console.error(`parley: handle.stop failed for ${callId}`, error);
      }
    }
    await deps.onCallCompleted?.({
      callId,
      endedAt: new Date().toISOString(),
      transcript: handle.transcript,
      endedBy: handle.endedBy ?? "remote",
      isMeeting: session.isMeeting,
      startedAt,
      consentReceipt: session.consentReceipt,
      gaps: session.gaps,
      gapMs: session.gapMs,
      coveredMs: session.coveredMs,
      modelTurnsCompleted: session.modelTurnsCompleted,
      realtime: session.realtime,
      ...(session.firstModelAudioAtMs !== undefined
        ? { firstModelAudioMs: session.firstModelAudioAtMs }
        : {}),
      brief: session.meetingBrief,
      ...(session.operation ? { operation: session.operation } : {}),
      ...(session.expectedOutcomeFields
        ? { expectedOutcomeFields: session.expectedOutcomeFields }
        : {}),
      ...(session.answeredBy ? { answeredBy: session.answeredBy } : {}),
      ...session.gateSnapshot()
    });
  };
  socket.on("close", () => {
    closed = true;
    // Nothing upstream of a WebSocket "close" event can await this — but an
    // unhandled rejection here (e.g. a failed transcript write) would
    // otherwise crash the whole daemon over one call's post-processing.
    void evict().catch((error: unknown) => {
      console.error(`parley: onCallCompleted failed for ${callId}`, error);
    });
  });
  startedAt = new Date().toISOString();
  deps.pending.markConnected(callId);
  try {
    handle = await session.attach(callId, socket);
  } catch (error) {
    deps.pending.delete(callId);
    throw error;
  }
  if (closed) await evict();
  return true;
}

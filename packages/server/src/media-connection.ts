import type { EndReason, RecordedOutcome, TranscriptEvent, WebSocketLike } from "@parley/core";
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
}

/** Correlate an inbound media WebSocket to its pending CallSession by the
 * CallSid carried in the URL path (design spec §3), then attach. Evicts the
 * session from the registry when the socket closes. Returns false (and closes
 * the socket) if no session matches — an unknown/guessed callId gets nothing. */
export async function handleMediaConnection(
  callId: string,
  socket: WebSocketLike,
  deps: { pending: PendingSessions; onCallCompleted?: (record: CompletedCallRecord) => void }
): Promise<boolean> {
  const session = deps.pending.get(callId);
  if (!session) {
    socket.close();
    return false;
  }
  let closed = false;
  let stopped = false;
  let handle: Awaited<ReturnType<typeof session.attach>> | undefined = undefined;
  const evict = (): void => {
    deps.pending.delete(callId);
    if (handle) {
      deps.onCallCompleted?.({
        callId,
        endedAt: new Date().toISOString(),
        transcript: handle.transcript,
        // The socket closing without an explicit reason IS the far end hanging
        // up, which is why "remote" is the fallback rather than "error".
        endedBy: handle.endedBy ?? "remote",
        ...(session.answeredBy ? { answeredBy: session.answeredBy } : {}),
        ...session.gateSnapshot()
      });
    }
    if (handle && !stopped) {
      stopped = true;
      // The media socket closing IS the far end going away, so the reason is
      // "remote" — CallSession then skips asking the carrier to hang up a call
      // that is already over.
      void handle.stop("remote");
    }
  };
  socket.on("close", () => {
    closed = true;
    evict();
  });
  handle = await session.attach(callId, socket);
  if (closed) evict();
  return true;
}

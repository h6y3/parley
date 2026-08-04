import type { TranscriptEvent, WebSocketLike } from "@parley/core";
import type { PendingSessions } from "./pending-sessions.js";

export interface CompletedCallRecord {
  callId: string;
  endedAt: string;
  transcript: readonly TranscriptEvent[];
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
        transcript: handle.transcript
      });
    }
    if (handle && !stopped) {
      stopped = true;
      void handle.stop("socket closed");
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

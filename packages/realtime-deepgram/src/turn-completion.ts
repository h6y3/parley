/** How long agent audio must stay quiet after an `AgentAudioDone` before the
 * turn counts as complete.
 *
 * `AgentAudioDone` is not "the agent has finished speaking". In a billed wire
 * log Deepgram sent `end_call`, an `AgentAudioDone`, then about 1.3 s more
 * agent audio (the rest of the goodbye), then a second `AgentAudioDone`.
 * CallSession's farewell waits for the first turn completion and then drains
 * only the audio already queued, so a turn ended on the first `AgentAudioDone`
 * hung up over the words still to come. The same early end would release a
 * consent hand-off and count a model turn too soon.
 *
 * 300 ms is long against the gaps between frames of one reply — Deepgram
 * paces audio at roughly real time, with only small gaps between frames — and
 * short against every wait built on a turn end (CallSession bounds its own at
 * seconds). */
export const DEEPGRAM_TURN_QUIET_MS = 300;

/** Turn-end detection for a Deepgram Voice Agent socket: feed it every
 * `AgentAudioDone` and every agent audio frame, and it calls back once the
 * turn is really over. */
export interface DeepgramTurnCompletion {
  /** An `AgentAudioDone` arrived: (re)arm the quiet window. */
  audioDone(): void;
  /** Agent audio arrived. Inside an armed window this cancels the pending
   * completion — the turn is still speaking — and only a later
   * `AgentAudioDone` re-arms it. Outside one it does nothing. */
  audio(): void;
  /** Drop any pending completion, without firing it (the socket closed, or
   * the caller no longer wants this turn's end). */
  cancel(): void;
}

/** One implementation shared by `createDeepgramRealtimeProvider` and the
 * harness's Deepgram scenario transport, so the turn boundary a scenario
 * scores is the one production hangs up on. */
export function createDeepgramTurnCompletion(
  onComplete: () => void,
  quietMs: number = DEEPGRAM_TURN_QUIET_MS
): DeepgramTurnCompletion {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    audioDone() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        onComplete();
      }, quietMs);
    },
    audio() {
      if (timer !== undefined) cancel();
    },
    cancel
  };
}

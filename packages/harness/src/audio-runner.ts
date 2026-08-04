import type { AudioFrame, RealtimeProvider, TranscriptEvent } from "@parley/core";

export interface AudioScriptTurn {
  label: string;
  /** Empty array = a silence turn; the runner just waits for a response
   * instead of streaming audio. */
  frames: readonly AudioFrame[];
}

export interface AudioRunResult {
  turns: Array<{ label: string; transcript: TranscriptEvent[] }>;
  fullTranscript: TranscriptEvent[];
}

const DEFAULT_TURN_TIMEOUT_MS = 15000;

/** Runs a scripted, real-audio multi-turn call against a RealtimeProvider:
 * connect once, send the opening trigger, then stream each scripted turn's
 * audio frames and wait for the model's response to settle (an isFinal
 * transcript event, or a timeout) before moving to the next turn. This is the
 * harness's reliability-gate mechanism (design spec §10.1, §10.2) — pass the
 * real @parley/realtime-gemini GeminiRealtimeProvider for an actual gate run;
 * automated tests pass a fake RealtimeProvider so CI never calls a live API
 * (design spec §10.3). */
export async function runAudioScript(params: {
  provider: RealtimeProvider;
  model: string;
  systemInstruction: string;
  openingTrigger: string;
  turns: readonly AudioScriptTurn[];
  turnTimeoutMs?: number;
}): Promise<AudioRunResult> {
  const timeoutMs = params.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const fullTranscript: TranscriptEvent[] = [];
  let currentTurnTranscript: TranscriptEvent[] = [];
  let onTurnFinal: (() => void) | undefined;

  const session = await params.provider.connect({
    model: params.model,
    systemInstruction: params.systemInstruction,
    responseModality: "audio",
    callbacks: {
      onAudio: () => {},
      onInterrupted: () => {},
      onTranscript: (event) => {
        fullTranscript.push(event);
        currentTurnTranscript.push(event);
        if (event.isFinal) onTurnFinal?.();
      },
      onError: () => {},
      onClose: () => {}
    }
  });

  const waitForTurnEnd = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      onTurnFinal = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const turnResults: Array<{ label: string; transcript: TranscriptEvent[] }> = [];
  const finishTurn = (label: string) => {
    turnResults.push({ label, transcript: currentTurnTranscript });
    currentTurnTranscript = [];
    onTurnFinal = undefined;
  };

  try {
    session.sendOpeningTrigger(params.openingTrigger);
    await waitForTurnEnd();
    finishTurn("opening");

    for (const turn of params.turns) {
      for (const frame of turn.frames) {
        session.sendAudio(frame);
      }
      await waitForTurnEnd();
      finishTurn(turn.label);
    }
  } finally {
    await session.close();
  }
  return { turns: turnResults, fullTranscript };
}

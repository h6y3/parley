import {
  AudioBridge,
  planOpening,
  withOpening,
  type AudioFrame,
  type RealtimeProvider,
  type TranscriptEvent
} from "@parley/core";
import { convert } from "@parley/audio";

export interface AudioScriptTurn {
  label: string;
  /** Empty array = a silence turn; the runner just waits for a response
   * instead of streaming audio. */
  frames: readonly AudioFrame[];
}

/** One scripted turn as it was observed. Whether the model REPLIED cannot be
 * read from `transcript` alone: Gemini's output transcription arrives as deltas
 * behind the audio, so a spoken reply can be transcribed after `turnComplete`,
 * and a provider with transcription off never transcribes it at all. */
export interface AudioRunTurn {
  label: string;
  transcript: TranscriptEvent[];
  /** Bytes of model audio received during the turn. */
  modelAudioBytes: number;
  /** Model transcript that arrived after the turn ended and before the next
   * turn began (or the session closed): late deltas of this turn's reply. Not
   * repeated in the `transcript` of the turn that follows. */
  lateModelTranscript: TranscriptEvent[];
}

export interface AudioRunResult {
  turns: AudioRunTurn[];
  fullTranscript: TranscriptEvent[];
}

const DEFAULT_TURN_TIMEOUT_MS = 15000;

/** Runs a scripted, real-audio multi-turn call against a RealtimeProvider:
 * connect once, deliver the opening the way the provider declares it takes it
 * (`planOpening`, as `CallSession` does), then stream each scripted turn's
 * audio frames and wait for the model's turn to end (the provider's
 * `onTurnComplete`, or a timeout) before moving to the next turn. This is the
 * harness's reliability-gate mechanism (design spec §10.1, §10.2) — pass a
 * real realtime provider (Gemini or Deepgram) for an actual gate run;
 * automated tests pass a fake RealtimeProvider so CI never calls a live API
 * (design spec §10.3). */
export async function runAudioScript(params: {
  provider: RealtimeProvider;
  model: string;
  /** The rendered brief. The opening is NOT caller-supplied: it is planned
   * here from the provider's `openingDelivery` and `meeting`, by the helper a
   * real call uses, so a gate run cannot put a different opening in front of
   * the model than production would. */
  systemInstruction: string;
  /** Whether the script is a meeting. Absent is an ordinary two-party call —
   * every reliability scenario today. */
  meeting?: boolean;
  turns: readonly AudioScriptTurn[];
  turnTimeoutMs?: number;
}): Promise<AudioRunResult> {
  const timeoutMs = params.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const fullTranscript: TranscriptEvent[] = [];
  let currentTurnTranscript: TranscriptEvent[] = [];
  let onTurnEnd: (() => void) | undefined;
  let modelAudioBytes = 0;
  // Where model transcript goes between a turn's end and the next turn's start.
  let lateSink: TranscriptEvent[] | undefined;

  // Fixtures are committed as 16 kHz PCM, but each provider declares what it
  // will take on the wire (Deepgram: mu-law 8 kHz only). The same bridge the
  // live call path uses adapts them, so a run exercises the provider on the
  // audio it would actually receive rather than on a format it was never sent.
  const bridge = new AudioBridge(params.provider.audio.accepts, convert);

  const opening = planOpening(params.provider.openingDelivery, params.meeting ?? false);
  // A Parley constant, never caller content — the one-shot instruction stays
  // rendered brief plus fixed text, joined by the helper a real call uses.
  const systemInstruction = withOpening(params.systemInstruction, opening);

  const session = await params.provider.connect({
    model: params.model,
    systemInstruction,
    responseModality: "audio",
    callbacks: {
      onAudio: (frame) => {
        modelAudioBytes += frame.data.length;
      },
      onInterrupted: () => {},
      onTranscript: (event) => {
        fullTranscript.push(event);
        // A model delta after the turn ended belongs to that turn, not to
        // whichever one the script starts next.
        if (event.speaker === "model" && lateSink) lateSink.push(event);
        else currentTurnTranscript.push(event);
      },
      // The turn is the MODEL's, so it ends on the provider's own turn end —
      // never on a final transcript. `isFinal` closes an utterance, and on
      // Deepgram every `ConversationText` is final, the caller's included: a
      // runner that ended on any final closed the session as soon as the
      // derail line was transcribed, before the model could answer it. Nor on
      // a final MODEL transcript: Deepgram sends the reply's text before its
      // audio has played out, and the next scripted turn streamed then would
      // barge into it. Both production providers call this — Gemini on
      // `turnComplete`, Deepgram on `AgentAudioDone` once its audio has gone
      // quiet, which it sends for a silent turn too — so a model that says
      // nothing still ends its turn.
      onTurnComplete: () => onTurnEnd?.(),
      onError: () => {},
      onClose: () => {}
    }
  });

  const waitForTurnEnd = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      onTurnEnd = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const turnResults: AudioRunTurn[] = [];
  const finishTurn = (label: string) => {
    const lateModelTranscript: TranscriptEvent[] = [];
    turnResults.push({
      label,
      transcript: currentTurnTranscript,
      modelAudioBytes,
      lateModelTranscript
    });
    currentTurnTranscript = [];
    modelAudioBytes = 0;
    lateSink = lateModelTranscript;
    onTurnEnd = undefined;
  };

  try {
    // Nothing to send means nothing to answer: a "prompt" provider's
    // two-party call opens on the callee's first turn, so waiting out a
    // timeout here would only add silence. The "opening" turn is still
    // recorded, empty, so every run has the same turn shape.
    if (opening.trigger !== undefined) {
      session.sendOpeningTrigger(opening.trigger);
      await waitForTurnEnd();
    }
    finishTurn("opening");

    for (const turn of params.turns) {
      lateSink = undefined;
      for (const frame of turn.frames) {
        session.sendAudio(bridge.adapt(frame));
      }
      await waitForTurnEnd();
      finishTurn(turn.label);
    }
  } finally {
    await session.close();
  }
  return { turns: turnResults, fullTranscript };
}

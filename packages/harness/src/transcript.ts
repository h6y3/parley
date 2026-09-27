import type { SpeakerRole, TranscriptEvent } from "@parley/core";

export interface Utterance {
  speaker: SpeakerRole;
  speakerId?: string;
  text: string;
}

/**
 * Reconstructs per-turn utterances from a provider's raw TranscriptEvent stream.
 *
 * Two producer shapes, distinguished by `segmentId`:
 *
 * - **Append-only deltas** (no `segmentId`; @parley/realtime-gemini). One event
 *   per fragment, concatenated WITH NO SEPARATOR so a phrase split across
 *   deltas reconstructs verbatim.
 * - **Segment revisions** (`segmentId` set; streaming ASR). Each event is the
 *   whole segment so far, so the latest REPLACES its predecessors. Appending
 *   these produces "thethe quickthe quick brown".
 *
 * A turn closes on `isFinal`, when the `(speaker, speakerId)` tuple changes, or
 * when the `segmentId` changes. The tuple — not the role alone — is the
 * boundary, because under diarization every human shares the role
 * `participant`, and closing on role would merge three people into one
 * utterance that the evaluation layer would then score as though it were one.
 */
export function aggregateTranscript(events: readonly TranscriptEvent[]): Utterance[] {
  const utterances: Utterance[] = [];
  let speaker: SpeakerRole | undefined;
  let speakerId: string | undefined;
  let segmentId: string | undefined;
  let text = "";
  let open = false;

  const close = (): void => {
    if (!open) return;
    utterances.push({
      speaker: speaker as SpeakerRole,
      ...(speakerId === undefined ? {} : { speakerId }),
      text
    });
    open = false;
    text = "";
    segmentId = undefined;
  };

  for (const event of events) {
    const speakerChanged = open && (event.speaker !== speaker || event.speakerId !== speakerId);
    const segmentChanged = open && event.segmentId !== segmentId;
    if (speakerChanged || segmentChanged) close();

    speaker = event.speaker;
    speakerId = event.speakerId;
    segmentId = event.segmentId;
    // A segment revision is the whole segment so far; a delta is an increment.
    text = event.segmentId === undefined ? text + event.text : event.text;
    open = true;
    if (event.isFinal) close();
  }
  close();
  return utterances;
}

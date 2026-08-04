import type { TranscriptEvent } from "@parley/core";

export interface Utterance {
  speaker: "caller" | "model";
  text: string;
}

/**
 * Reconstructs per-turn utterances from a provider's raw TranscriptEvent
 * stream. Providers (e.g. @parley/realtime-gemini) emit `TranscriptEvent.text`
 * as an incremental DELTA, one event per fragment, closing a turn with an
 * `isFinal: true` event (often empty-text). Consecutive same-speaker deltas are
 * concatenated WITH NO SEPARATOR — exactly how the producer fragmented them — so
 * a phrase split across deltas reconstructs verbatim. A turn closes on `isFinal`
 * or when the speaker changes.
 */
export function aggregateTranscript(events: readonly TranscriptEvent[]): Utterance[] {
  const utterances: Utterance[] = [];
  let speaker: "caller" | "model" | undefined;
  let text = "";
  let open = false;

  const close = () => {
    if (open) {
      utterances.push({ speaker: speaker as "caller" | "model", text });
      open = false;
      text = "";
    }
  };

  for (const event of events) {
    if (open && event.speaker !== speaker) close();
    speaker = event.speaker;
    text += event.text;
    open = true;
    if (event.isFinal) close();
  }
  close();
  return utterances;
}

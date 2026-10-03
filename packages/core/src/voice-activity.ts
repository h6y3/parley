import type { AudioFrame } from "./types.js";

/** A frame is voiced when its RMS is at least this far above the noise floor… */
export const VOICE_MARGIN_DB = 12;
/** …and never below this, so steady μ-law line hiss on a quiet line is not a
 * voice however low the floor reads. */
export const VOICE_MIN_DBFS = -45;
/** Voiced audio this long, without a break, is an utterance — shorter is a
 * click or a pop. */
export const UTTERANCE_MIN_MS = 300;
/** Unvoiced audio this long after an utterance ends it. */
export const UTTERANCE_END_MS = 300;
/** A dip shorter than this inside a voiced run does not break it: the gap
 * between two syllables is not silence. */
const DIP_TOLERANCE_MS = 60;
/** The noise floor is the quietest UNVOICED frame of the last this-many ms,
 * counting only frames heard outside any voiced run or utterance. */
const FLOOR_WINDOW_MS = 3_000;
/** The floor before any unvoiced frame has been heard. Fixed and low, so it
 * does not depend on the opening frames being silence: a callee who says
 * hello in frame 0 is measured against −45 dBFS, not against their own voice
 * (a floor learnt from those frames would have been the greeting itself). */
export const INITIAL_FLOOR_DBFS = -60;
/** dBFS given to an all-zero frame, so digital silence has a finite floor. */
const SILENT_DBFS = -100;

export interface VoiceActivityEvents {
  /** The far end has been voiced for UTTERANCE_MIN_MS. `startMs` is where the
   * voiced run began, in media time (ms of inbound audio since the stream
   * attached). */
  onUtteranceStart(startMs: number): void;
  /** UTTERANCE_END_MS of unvoiced audio followed that utterance. */
  onUtteranceEnd(startMs: number): void;
}

/** G.711 μ-law byte → 16-bit linear sample. */
function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << exponent) - 0x84;
  return u & 0x80 ? -magnitude : magnitude;
}

/** RMS of one frame in dBFS (full scale 32768), or undefined for an encoding
 * this detector does not read. */
export function frameDbfs(frame: AudioFrame): number | undefined {
  const { data } = frame;
  let sum = 0;
  let count = 0;
  if (frame.encoding.codec === "mulaw") {
    for (let i = 0; i < data.length; i += 1) {
      const s = mulawToLinear(data[i]!);
      sum += s * s;
    }
    count = data.length;
  } else if (frame.encoding.codec === "pcm") {
    for (let i = 0; i + 1 < data.length; i += 2) {
      const s = data.readInt16LE(i);
      sum += s * s;
    }
    count = Math.floor(data.length / 2);
  } else {
    return undefined;
  }
  if (count === 0) return undefined;
  if (sum === 0) return SILENT_DBFS;
  return Math.max(SILENT_DBFS, 20 * Math.log10(Math.sqrt(sum / count) / 32768));
}

/**
 * A small, deterministic energy VAD over the far end's inbound carrier audio,
 * independent of any realtime provider's transcript. A frame is voiced when
 * its RMS is at least max(noise floor + VOICE_MARGIN_DB, VOICE_MIN_DBFS). The
 * floor starts at INITIAL_FLOOR_DBFS and is then the quietest unvoiced frame of
 * the last FLOOR_WINDOW_MS. It is FROZEN while a voiced run or an utterance is
 * in progress: only unvoiced frames between utterances move it. Learnt from
 * every frame, any sustained sound over the window — hold music, a queue or
 * fax tone, loud steady background — became the floor mid-sound, read as
 * unvoiced, "ended" the utterance while it went on, and the cue went out into
 * it. Frozen, a sound that never stops is one utterance that never ends: the
 * nudge never arms, which fails safe. All timing is media
 * time — summed frame durations — so it is the same whether frames arrive
 * paced or in a burst.
 */
export class FarEndVoiceDetector {
  private mediaMs = 0;
  /** Unvoiced frames heard between utterances, within FLOOR_WINDOW_MS. */
  private readonly recent: { atMs: number; db: number }[] = [];
  private floorDb = INITIAL_FLOOR_DBFS;
  /** Media time the current voiced run began, while one is running. */
  private runStartMs?: number;
  private runVoicedMs = 0;
  private dipMs = 0;
  /** Set once a run has become an utterance, until it ends. */
  private utteranceStartMs?: number;
  private silentMs = 0;

  constructor(private readonly events: VoiceActivityEvents) {}

  /** Whether an utterance is in progress. */
  get speaking(): boolean {
    return this.utteranceStartMs !== undefined;
  }

  accept(frame: AudioFrame): void {
    const db = frameDbfs(frame);
    const sampleBytes = frame.encoding.codec === "pcm" ? 2 : 1;
    const durationMs = (frame.data.length / sampleBytes / frame.encoding.sampleRate) * 1000;
    const atMs = this.mediaMs;
    this.mediaMs += durationMs;
    if (db === undefined || durationMs <= 0) return;

    const voiced = db >= Math.max(this.floorDb + VOICE_MARGIN_DB, VOICE_MIN_DBFS);
    if (!voiced && this.utteranceStartMs === undefined && this.runStartMs === undefined) {
      while (this.recent.length > 0 && this.recent[0]!.atMs < atMs - FLOOR_WINDOW_MS) {
        this.recent.shift();
      }
      this.recent.push({ atMs, db });
      this.floorDb = this.recent.reduce((min, f) => Math.min(min, f.db), db);
    }

    if (this.utteranceStartMs !== undefined) {
      if (voiced) {
        this.silentMs = 0;
        return;
      }
      this.silentMs += durationMs;
      if (this.silentMs >= UTTERANCE_END_MS) {
        const start = this.utteranceStartMs;
        this.utteranceStartMs = undefined;
        this.silentMs = 0;
        this.resetRun();
        this.events.onUtteranceEnd(start);
      }
      return;
    }

    if (voiced) {
      this.runStartMs ??= atMs;
      this.runVoicedMs += durationMs + this.dipMs;
      this.dipMs = 0;
      if (this.runVoicedMs >= UTTERANCE_MIN_MS) {
        this.utteranceStartMs = this.runStartMs;
        this.silentMs = 0;
        this.events.onUtteranceStart(this.runStartMs);
      }
      return;
    }
    if (this.runStartMs === undefined) return;
    this.dipMs += durationMs;
    if (this.dipMs >= DIP_TOLERANCE_MS) this.resetRun();
  }

  private resetRun(): void {
    this.runStartMs = undefined;
    this.runVoicedMs = 0;
    this.dipMs = 0;
  }
}

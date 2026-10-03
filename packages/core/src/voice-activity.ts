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

/** An utterance whose voiced energy is at least this concentrated in at most
 * two narrow bins (see `ToneSpectrum`) is a tone, not a voice. */
export const TONE_CONCENTRATION = 0.8;

/** What the detector knows about an utterance when it reports it. */
export interface UtteranceInfo {
  /** True when tone classification is on and the utterance's voiced frames so
   * far are a steady single or dual tone — ringback (440 + 480 Hz), a dial,
   * busy or DTMF tone, a beep. Always false when classification is off. */
  tone: boolean;
}

export interface VoiceActivityEvents {
  /** The far end has been voiced for UTTERANCE_MIN_MS. `startMs` is where the
   * voiced run began, in media time (ms of inbound audio since the stream
   * attached). `info.tone` is classified from the run so far. */
  onUtteranceStart(startMs: number, info: UtteranceInfo): void;
  /** UTTERANCE_END_MS of unvoiced audio followed that utterance. `info.tone`
   * is classified from the whole utterance. */
  onUtteranceEnd(startMs: number, info: UtteranceInfo): void;
}

export interface VoiceActivityOptions {
  /** Classify each utterance as a tone or not (`UtteranceInfo.tone`). Off by
   * default, so a detector that does not need it does no spectral work. */
  classifyTones?: boolean;
}

/** G.711 μ-law byte → 16-bit linear sample. */
function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << exponent) - 0x84;
  return u & 0x80 ? -magnitude : magnitude;
}

/** A frame's samples as linear 16-bit values, or undefined for an encoding
 * this module does not read. */
function frameSamples(frame: AudioFrame): Float64Array | undefined {
  const { data } = frame;
  if (frame.encoding.codec === "mulaw") {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = mulawToLinear(data[i]!);
    return out;
  }
  if (frame.encoding.codec === "pcm") {
    const out = new Float64Array(Math.floor(data.length / 2));
    for (let i = 0; i < out.length; i += 1) out[i] = data.readInt16LE(i * 2);
    return out;
  }
  return undefined;
}

/** Spacing of the tone bins: 20 ms frames give 50 Hz resolution. */
const TONE_BIN_HZ = 50;
/** Highest bin examined (3950 Hz), within a narrowband call's passband. */
const TONE_MAX_BIN = 79;
/** Hann-windowed DFT basis per (frame length, sample rate), built once. */
const toneBases = new Map<string, { cos: Float64Array[]; sin: Float64Array[]; bins: number }>();

function toneBasis(n: number, sampleRate: number) {
  const key = `${n}:${sampleRate}`;
  let basis = toneBases.get(key);
  if (basis === undefined) {
    const bins = Math.min(TONE_MAX_BIN, Math.floor((sampleRate / 2 - 1) / TONE_BIN_HZ));
    const cos: Float64Array[] = [];
    const sin: Float64Array[] = [];
    for (let k = 1; k <= bins; k += 1) {
      const c = new Float64Array(n);
      const s = new Float64Array(n);
      const w = (2 * Math.PI * k * TONE_BIN_HZ) / sampleRate;
      for (let i = 0; i < n; i += 1) {
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
        c[i] = hann * Math.cos(w * i);
        s[i] = hann * Math.sin(w * i);
      }
      cos.push(c);
      sin.push(s);
    }
    basis = { cos, sin, bins };
    toneBases.set(key, basis);
  }
  return basis;
}

/**
 * Power at 50 Hz steps (50–3950 Hz) summed over the frames of one utterance,
 * from a Hann-windowed DFT of each frame — about 13k multiply-adds per 20 ms
 * frame, done only while an utterance is in progress. `concentration()` is the
 * share of that power within ±1 bin (a 150 Hz span) of the strongest peak and
 * of the next strongest outside it: near 1 for a steady single or dual tone —
 * ringback's 440 + 480 Hz pair falls in one or two such spans — and far lower
 * for a voice, whose harmonics glide and spread across many bins.
 */
export class ToneSpectrum {
  private power = new Float64Array(TONE_MAX_BIN + 1);
  private frames = 0;

  add(frame: AudioFrame): void {
    const x = frameSamples(frame);
    if (x === undefined || x.length === 0) return;
    const { cos, sin, bins } = toneBasis(x.length, frame.encoding.sampleRate);
    for (let k = 1; k <= bins; k += 1) {
      const c = cos[k - 1]!;
      const s = sin[k - 1]!;
      let re = 0;
      let im = 0;
      for (let i = 0; i < x.length; i += 1) {
        re += x[i]! * c[i]!;
        im += x[i]! * s[i]!;
      }
      this.power[k] += re * re + im * im;
    }
    this.frames += 1;
  }

  /** Share of the summed power in at most two narrow spans, 0 when empty. */
  concentration(): number {
    const p = this.power;
    let total = 0;
    for (let k = 1; k < p.length; k += 1) total += p[k]!;
    if (this.frames === 0 || total <= 0) return 0;
    const used = new Uint8Array(p.length);
    let captured = 0;
    for (let peak = 0; peak < 2; peak += 1) {
      let best = -1;
      for (let k = 1; k < p.length; k += 1) {
        if (!used[k] && (best < 0 || p[k]! > p[best]!)) best = k;
      }
      if (best < 0) break;
      for (let k = Math.max(1, best - 1); k <= Math.min(p.length - 1, best + 1); k += 1) {
        if (used[k]) continue;
        used[k] = 1;
        captured += p[k]!;
      }
    }
    return captured / total;
  }

  isTone(): boolean {
    return this.concentration() >= TONE_CONCENTRATION;
  }

  reset(): void {
    this.power = new Float64Array(TONE_MAX_BIN + 1);
    this.frames = 0;
  }
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
  private mediaTimeMs = 0;
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
  /** Voiced frames of the current run or utterance, when classifying tones. */
  private readonly spectrum?: ToneSpectrum;

  constructor(
    private readonly events: VoiceActivityEvents,
    options: VoiceActivityOptions = {}
  ) {
    if (options.classifyTones) this.spectrum = new ToneSpectrum();
  }

  /** Media time heard so far: ms of inbound audio since the first frame. The
   * clock every `startMs` is on. */
  get mediaMs(): number {
    return this.mediaTimeMs;
  }

  private info(): UtteranceInfo {
    return { tone: this.spectrum?.isTone() ?? false };
  }

  /** Whether an utterance is in progress. */
  get speaking(): boolean {
    return this.utteranceStartMs !== undefined;
  }

  accept(frame: AudioFrame): void {
    const db = frameDbfs(frame);
    const sampleBytes = frame.encoding.codec === "pcm" ? 2 : 1;
    const durationMs = (frame.data.length / sampleBytes / frame.encoding.sampleRate) * 1000;
    const atMs = this.mediaTimeMs;
    this.mediaTimeMs += durationMs;
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
        this.spectrum?.add(frame);
        this.silentMs = 0;
        return;
      }
      this.silentMs += durationMs;
      if (this.silentMs >= UTTERANCE_END_MS) {
        const start = this.utteranceStartMs;
        const info = this.info();
        this.utteranceStartMs = undefined;
        this.silentMs = 0;
        this.resetRun();
        this.events.onUtteranceEnd(start, info);
      }
      return;
    }

    if (voiced) {
      this.runStartMs ??= atMs;
      this.spectrum?.add(frame);
      this.runVoicedMs += durationMs + this.dipMs;
      this.dipMs = 0;
      if (this.runVoicedMs >= UTTERANCE_MIN_MS) {
        this.utteranceStartMs = this.runStartMs;
        this.silentMs = 0;
        this.events.onUtteranceStart(this.runStartMs, this.info());
      }
      return;
    }
    if (this.runStartMs === undefined) return;
    this.dipMs += durationMs;
    if (this.dipMs >= DIP_TOLERANCE_MS) this.resetRun();
  }

  private resetRun(): void {
    this.spectrum?.reset();
    this.runStartMs = undefined;
    this.runVoicedMs = 0;
    this.dipMs = 0;
  }
}

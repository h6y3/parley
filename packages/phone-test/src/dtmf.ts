import { muLawDecodeSample } from "@parley/audio";

/**
 * In-band DTMF detection on the agent's audio.
 *
 * Parley presses keys by putting the two tones into its outbound audio (see
 * `@parley/audio`'s `dtmfMuLaw`), and Twilio Media Streams does not raise a
 * `dtmf` event for tones that arrive that way on the sim's leg: on the first
 * campaign the agent pressed "2" on every menu call and the simulated menu
 * never heard it. So the sim listens for the tones itself, as a real phone
 * menu does.
 *
 * Goertzel over 205-sample windows (25.6 ms at 8 kHz, about 39 Hz per bin,
 * the classic DTMF block) with a 10 ms hop. A window holds a key when:
 * - one row and one column tone are each above an absolute level;
 * - their twist (row/column energy ratio) is within 8 dB;
 * - every other DTMF tone is at least 10 dB below the weaker of the two;
 * - the pair carries most of the window's energy (speech and noise spread it).
 * A key is a digit once three consecutive windows hold it (a 40 ms tone is
 * enough, a 30 ms one is not), and it is released only after five windows
 * without it (a gap of 40 ms or more), so one press is one digit.
 */

const RATE = 8000;
const WINDOW = 205;
const HOP = 80;
const ROWS = [697, 770, 852, 941] as const;
const COLS = [1209, 1336, 1477, 1633] as const;
const KEYPAD = [
  ["1", "2", "3", "A"],
  ["4", "5", "6", "B"],
  ["7", "8", "9", "C"],
  ["*", "0", "#", "D"]
] as const;
/** The keys a phone menu offers; the A–D column is detected but never reported. */
const REPORTED = /^[0-9*#]$/;

/** Each tone's peak amplitude must reach this (dBFS, full scale 32768). */
const MIN_TONE_DBFS = -36;
const MAX_TWIST_DB = 8;
const OTHER_TONES_BELOW_DB = 10;
/** The pair's share of the window's total energy. */
const MIN_PAIR_SHARE = 0.75;
/** Consecutive windows holding a key before it is a digit: a 40 ms tone is
 * detected, a 30 ms one is not (ITU-T Q.24 leaves the band between open). */
const ON_WINDOWS = 3;
/** Consecutive windows without it before the key is released. A window that
 * straddles a tone's edge does not hold the key, so five windows release on a
 * gap of 40 ms or more and bridge a dropout of 30 ms or less inside a press. */
const OFF_WINDOWS = 5;

const FREQS = [...ROWS, ...COLS];
const COEFFS = FREQS.map((f) => 2 * Math.cos((2 * Math.PI * f) / RATE));
const MIN_TONE_AMP = 32768 * 10 ** (MIN_TONE_DBFS / 20);
/** A sinusoid of amplitude A over N samples has Σx² ≈ A²N/2. */
const MIN_TONE_ENERGY = (MIN_TONE_AMP * MIN_TONE_AMP * WINDOW) / 2;
const db = (ratio: number): number => 10 * Math.log10(ratio);

/** The key one window holds, or undefined. */
function classify(x: Float64Array): string | undefined {
  let total = 0;
  for (let i = 0; i < WINDOW; i++) total += x[i]! * x[i]!;
  if (total === 0) return undefined;
  // Goertzel power, normalised so a pure tone's value is its Σx².
  const energy = COEFFS.map((c) => {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < WINDOW; i++) {
      const s0 = x[i]! + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return ((s1 * s1 + s2 * s2 - c * s1 * s2) * 2) / WINDOW;
  });
  const argmax = (from: number): number => {
    let best = from;
    for (let i = from + 1; i < from + 4; i++) if (energy[i]! > energy[best]!) best = i;
    return best;
  };
  const row = argmax(0);
  const col = argmax(4);
  const er = energy[row]!;
  const ec = energy[col]!;
  if (er < MIN_TONE_ENERGY || ec < MIN_TONE_ENERGY) return undefined;
  if (Math.abs(db(er / ec)) > MAX_TWIST_DB) return undefined;
  const weaker = Math.min(er, ec);
  for (let i = 0; i < energy.length; i++) {
    if (i === row || i === col) continue;
    if (db(weaker / energy[i]!) < OTHER_TONES_BELOW_DB) return undefined;
  }
  if ((er + ec) / total < MIN_PAIR_SHARE) return undefined;
  return KEYPAD[row]![col - 4];
}

/** Streams μ-law 8 kHz audio in frames of any size; returns the digits each
 * frame completes. One detector per call: it carries state across frames. */
export class DtmfDetector {
  private pending = new Float64Array(0);
  private candidate: string | undefined;
  private run = 0;
  private active: string | undefined;
  private offRun = 0;

  push(mulaw: Buffer): string[] {
    const next = new Float64Array(this.pending.length + mulaw.length);
    next.set(this.pending);
    for (let i = 0; i < mulaw.length; i++) {
      next[this.pending.length + i] = muLawDecodeSample(mulaw[i]!);
    }
    const digits: string[] = [];
    let at = 0;
    for (; at + WINDOW <= next.length; at += HOP) {
      const digit = this.step(classify(next.subarray(at, at + WINDOW)));
      if (digit !== undefined) digits.push(digit);
    }
    this.pending = next.slice(at);
    return digits;
  }

  private step(key: string | undefined): string | undefined {
    if (key !== undefined && key === this.candidate) {
      this.run++;
    } else {
      this.candidate = key;
      this.run = key === undefined ? 0 : 1;
    }
    if (this.active !== undefined) {
      this.offRun = key === this.active ? 0 : this.offRun + 1;
      if (this.offRun >= OFF_WINDOWS) this.active = undefined;
    }
    if (this.active === undefined && this.candidate !== undefined && this.run >= ON_WINDOWS) {
      this.active = this.candidate;
      this.offRun = 0;
      return REPORTED.test(this.active) ? this.active : undefined;
    }
    return undefined;
  }
}

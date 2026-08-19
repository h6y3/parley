import type { AudioFrame } from "@parley/core";
import { muLawEncode } from "./mulaw.js";

/**
 * DTMF as AUDIO, sent in-band through the media stream the call is already on.
 *
 * The Twilio provider used to press keys by POSTing
 * `<Response><Play digits="1"/></Response>` to the live call. That is not a
 * keypress — posting TwiML REDIRECTS a call, so it tore down the
 * `<Connect><Stream>` carrying the conversation, played the tone to nobody,
 * reached the end of the new document, and hung up. On the first live call that
 * pressed a key, the callee heard a tone and the line went dead. Every time.
 *
 * There is no non-destructive REST way to send DTMF on a call that is inside a
 * media stream, and there does not need to be: a telephone keypad has always
 * worked by putting two sine waves into the audio path. So do that. The tones
 * ride the outbound audio the model is already speaking through, the stream
 * survives, and the far end's detector hears exactly what it hears from a human
 * caller's handset.
 */

/** The standard grid: each key is one row frequency plus one column frequency. */
export const DTMF_FREQUENCIES: Record<string, readonly [number, number]> = Object.freeze({
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  A: [697, 1633],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  B: [770, 1633],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  C: [852, 1633],
  "*": [941, 1209],
  "0": [941, 1336],
  "#": [941, 1477],
  D: [941, 1633]
});

const RATE = 8000;
/** ITU-T Q.24 puts the floor at 40ms of tone and 40ms of pause. These are well
 * clear of it: an IVR that misses a keypress costs a whole call, and a hundred
 * extra milliseconds costs nothing anyone can hear. */
const DEFAULT_TONE_MS = 180;
const DEFAULT_GAP_MS = 80;
/** Per-tone amplitude. The two sum, so 0.35 each peaks near 0.7 of full scale
 * and leaves headroom — a clipped DTMF pair is harmonic mush that detectors
 * reject. */
const AMPLITUDE = 0.35;

export interface DtmfOptions {
  toneMs?: number;
  gapMs?: number;
}

/** Render `digits` as one 8kHz mu-law frame, tone-gap-tone-gap. */
export function dtmfMuLaw(digits: string, options: DtmfOptions = {}): AudioFrame {
  const toneMs = options.toneMs ?? DEFAULT_TONE_MS;
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;
  const toneSamples = Math.round((toneMs / 1000) * RATE);
  const gapSamples = Math.round((gapMs / 1000) * RATE);

  const keys = [...digits];
  for (const key of keys) {
    if (!(key in DTMF_FREQUENCIES)) throw new Error(`not a telephone key: ${key}`);
  }

  const samples = new Int16Array(keys.length * (toneSamples + gapSamples));
  let at = 0;
  for (const key of keys) {
    const [low, high] = DTMF_FREQUENCIES[key];
    for (let n = 0; n < toneSamples; n++) {
      const t = n / RATE;
      const value =
        AMPLITUDE * Math.sin(2 * Math.PI * low * t) + AMPLITUDE * Math.sin(2 * Math.PI * high * t);
      samples[at + n] = Math.round(value * 32767);
    }
    at += toneSamples + gapSamples; // the gap is left as zeros
  }

  return { encoding: "mulaw8k", data: muLawEncode(samples) };
}

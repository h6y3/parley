import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Timeline } from "./capture.js";

/** Pass/fail limits for the timing codes, read from `configs/thresholds.json`.
 * Each code fires when its metric is strictly greater than the limit. */
export interface Thresholds {
  slowResponseP50Ms: number;
  slowResponseP90Ms: number;
  talkOverMs: number;
  slowBargeInMs: number;
  talkedAfterGoodbyeMs: number;
  deadAirMs: number;
  /** A callee overlap shorter than this that ends inside the agent's segment
   * is a backchannel ("mm-hm"), not a barge-in: talking through it is right.
   * Not a code threshold. */
  bargeInMinCalleeMs: number;
}

export type TimingCode =
  | "slow-response"
  | "spoke-before-callee"
  | "talk-over"
  | "slow-barge-in"
  | "talked-after-goodbye"
  | "dead-air"
  /** The sim's callee had to say "Hello?" again into silence: the agent did
   * not answer its greeting. The reprompt rescues the call before dead air
   * can fire and drops the unanswered gap, so this code is the only trace. */
  | "callee-reprompted";

export interface TimingReport {
  /** Callee segment end → the agent's next segment start, one per callee turn
   * the agent answered without overlapping it. */
  responseGapsMs: number[];
  /** Nearest-rank percentiles of `responseGapsMs`; 0 when there are none. */
  p50: number;
  p90: number;
  /** Every stretch where both channels were active, whoever started it. */
  overlapsMs: number[];
  /** For each barge-in (a callee-started overlap that is turn-length, or runs
   * past the agent's segment end): callee start → agent segment end. */
  bargeInStopsMs: number[];
  /** Callee-started overlaps too short to be a turn and contained in the
   * agent's segment, by overlap length. Never a code. */
  backchannelsMs: number[];
  spokeBeforeCallee: boolean;
  /** Total agent speech after the callee's goodbye. */
  talkedAfterGoodbyeMs: number;
  /** Every mutual silence between the first speech and the goodbye. */
  deadAirMs: number[];
  /** `callee-reprompt` events on the timeline. */
  repromptCount: number;
  codes: TimingCode[];
}

export interface Segment {
  startMs: number;
  endMs: number;
}

const FRAME_MS = 20;
/** dBFS assigned to an all-zero frame, so digital silence has a finite floor. */
const SILENT_FRAME_DB = -100;
const FLOOR_PERCENTILE = 0.2;
const MARGIN_DB = 12;
const MIN_THRESHOLD_DBFS = -45;
/** Speech hangover. A dip this short never ends a segment, but the 200 ms
 * merge below already bridges it, so it never moves a boundary on its own.
 * `endMs` is the last voiced frame, not voiced + hangover, so response gaps
 * are not biased 60 ms short. */
const HANGOVER_MS = 60;
const MERGE_GAP_MS = 200;
const MIN_SEGMENT_MS = 120;
/** Agent energy this close to a reported keypress is the in-band DTMF tone. */
const DTMF_WINDOW_MS = 300;

function frameDb(pcm: Int16Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += pcm[i] * pcm[i];
  if (sum === 0) return SILENT_FRAME_DB;
  const rms = Math.sqrt(sum / (to - from));
  return Math.max(SILENT_FRAME_DB, 20 * Math.log10(rms / 32768));
}

/**
 * Energy VAD over one 8 kHz channel. 20 ms frames, RMS in dBFS (full scale
 * 32768). The threshold is relative to the channel's own noise floor — the
 * 20th percentile of frame dB over the whole call — plus 12 dB, never below
 * -45 dBFS, so steady μ-law line hiss does not read as speech. Gaps under
 * 200 ms merge, then segments under 120 ms are dropped as clicks.
 *
 * The floor assumes the channel is silent for at least a fifth of the call,
 * which holds for one side of a conversation.
 */
export function segments(pcm: Int16Array, sampleRate: 8000): Segment[] {
  const frameLen = (sampleRate * FRAME_MS) / 1000;
  const frames = Math.floor(pcm.length / frameLen);
  if (frames === 0) return [];
  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f++) db[f] = frameDb(pcm, f * frameLen, (f + 1) * frameLen);

  const sorted = Float64Array.from(db).sort();
  const floor = sorted[Math.min(frames - 1, Math.floor(FLOOR_PERCENTILE * frames))];
  const threshold = Math.max(floor + MARGIN_DB, MIN_THRESHOLD_DBFS);

  // Voiced runs, bridged across dips shorter than the merge gap (which covers
  // the hangover).
  const bridgeFrames = Math.max(HANGOVER_MS, MERGE_GAP_MS) / FRAME_MS;
  const runs: Segment[] = [];
  let start = -1;
  let last = -1;
  for (let f = 0; f < frames; f++) {
    if (db[f] < threshold) continue;
    if (start >= 0 && f - last - 1 < bridgeFrames) {
      last = f;
      continue;
    }
    if (start >= 0) runs.push({ startMs: start * FRAME_MS, endMs: (last + 1) * FRAME_MS });
    start = f;
    last = f;
  }
  if (start >= 0) runs.push({ startMs: start * FRAME_MS, endMs: (last + 1) * FRAME_MS });
  return runs.filter((s) => s.endMs - s.startMs >= MIN_SEGMENT_MS);
}

function channels(wav: Buffer): { agent: Int16Array; callee: Int16Array } {
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.readUInt16LE(22) !== 2 ||
    wav.readUInt32LE(24) !== 8000 ||
    wav.readUInt16LE(34) !== 16
  ) {
    throw new Error("timing: expected a 16-bit stereo 8 kHz capture WAV");
  }
  const n = (wav.length - 44) >> 2;
  const agent = new Int16Array(n);
  const callee = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    agent[i] = wav.readInt16LE(44 + i * 4);
    callee[i] = wav.readInt16LE(44 + i * 4 + 2);
  }
  return { agent, callee };
}

/** Total voiced time (ms) on one channel of a stereo capture WAV, by the
 * same VAD as the timing analysis. Throws on a file that is not one. */
export function voicedMs(wav: Buffer, channel: "agent" | "callee"): number {
  return segments(channels(wav)[channel], 8000).reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.max(0, Math.ceil(p * sortedAsc.length) - 1)];
}

const overlap = (a: Segment, b: Segment): number =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/**
 * Turn-taking metrics from a stereo capture (L = agent, R = callee).
 *
 * - Response gap: a callee segment's end to the next agent segment's start,
 *   if the agent starts before the callee speaks again and was not already
 *   talking at that end. An agent segment that starts inside the callee's
 *   segment and runs past its end, overlapping by no more than `talkOverMs`,
 *   is a reply with gap 0.
 * - Overlap: both channels active. It is `talk-over` only when the agent's
 *   segment started after the callee's. A callee-started overlap is a
 *   barge-in, timed from the callee's start to the agent's segment end, when
 *   the callee segment is at least `bargeInMinCalleeMs` long or runs past the
 *   agent's segment end; otherwise it is a backchannel, which the agent is
 *   right to talk through.
 * - Spoke-before-callee: agent speech before the callee's first segment (the
 *   callee answers first in every persona).
 * - Goodbye: the later of the `callee-goodbye` event and the callee's last
 *   segment end (the event fires when the bot calls hang_up, possibly before
 *   its goodbye has finished playing); without the event, the last segment end.
 * - Dead air: mutual silences between the first speech and the goodbye.
 *
 * Agent segments within 300 ms of a `dtmf:` event are the agent's own keypad
 * tones arriving in-band. They are not speech for spoke-before-callee,
 * overlap, barge-in or talked-after-goodbye, but they still answer a turn and
 * still break a silence.
 */
export function analyzeTiming(wav: Buffer, timeline: Timeline, t: Thresholds): TimingReport {
  const pcm = channels(wav);
  const agentAll = segments(pcm.agent, 8000);
  const callee = segments(pcm.callee, 8000);

  const keypresses = timeline.events.filter((e) => e.event.startsWith("dtmf:")).map((e) => e.atMs);
  const isKeypress = (s: Segment): boolean =>
    keypresses.some((at) => s.startMs < at + DTMF_WINDOW_MS && s.endMs > at - DTMF_WINDOW_MS);
  const agent = agentAll.filter((s) => !isKeypress(s));

  const responseGapsMs: number[] = [];
  callee.forEach((c, i) => {
    const nextCallee = i + 1 < callee.length ? callee[i + 1].startMs : Infinity;
    const across = agentAll.find((a) => a.startMs < c.endMs && a.endMs > c.endMs);
    if (across) {
      // The agent came in just before the callee finished: the fastest reply
      // there is, so gap 0 — dropping it would bias p50 against fast
      // endpointing. A segment that started before the callee's, or overlaps
      // by talk-over length, is no reply to this segment.
      if (across.startMs > c.startMs && c.endMs - across.startMs <= t.talkOverMs) {
        responseGapsMs.push(0);
      }
      return;
    }
    const reply = agentAll.find((a) => a.startMs >= c.endMs);
    if (reply && reply.startMs < nextCallee) responseGapsMs.push(reply.startMs - c.endMs);
  });
  const sortedGaps = [...responseGapsMs].sort((x, y) => x - y);
  const p50 = percentile(sortedGaps, 0.5);
  const p90 = percentile(sortedGaps, 0.9);

  const overlapsMs: number[] = [];
  const bargeInStopsMs: number[] = [];
  const backchannelsMs: number[] = [];
  let talkOver = false;
  for (const a of agent) {
    for (const c of callee) {
      const ms = overlap(a, c);
      if (ms <= 0) continue;
      overlapsMs.push(ms);
      if (a.startMs > c.startMs) {
        if (ms > t.talkOverMs) talkOver = true;
      } else if (c.endMs - c.startMs >= t.bargeInMinCalleeMs || c.endMs > a.endMs) {
        bargeInStopsMs.push(a.endMs - c.startMs);
      } else {
        backchannelsMs.push(ms);
      }
    }
  }

  const firstCallee = callee.length > 0 ? callee[0].startMs : Infinity;
  const spokeBeforeCallee = agent.some((a) => a.startMs < firstCallee);

  const goodbyeEvent = timeline.events.find((e) => e.event === "callee-goodbye");
  const lastCalleeEnd = callee.length > 0 ? callee[callee.length - 1].endMs : undefined;
  const goodbye =
    goodbyeEvent !== undefined
      ? Math.max(goodbyeEvent.atMs, lastCalleeEnd ?? -Infinity)
      : lastCalleeEnd;
  const talkedAfterGoodbyeMs =
    goodbye === undefined
      ? 0
      : agent.reduce((sum, a) => sum + Math.max(0, a.endMs - Math.max(a.startMs, goodbye)), 0);

  const deadAirMs: number[] = [];
  const speech = [...agentAll, ...callee].sort((x, y) => x.startMs - y.startMs);
  let heardUntil = speech.length > 0 ? speech[0].endMs : 0;
  for (const s of speech.slice(1)) {
    if (s.startMs > heardUntil && (goodbye === undefined || s.startMs <= goodbye)) {
      deadAirMs.push(s.startMs - heardUntil);
    }
    heardUntil = Math.max(heardUntil, s.endMs);
  }

  const codes: TimingCode[] = [];
  if (p50 > t.slowResponseP50Ms || p90 > t.slowResponseP90Ms) codes.push("slow-response");
  if (spokeBeforeCallee) codes.push("spoke-before-callee");
  if (talkOver) codes.push("talk-over");
  if (bargeInStopsMs.some((ms) => ms > t.slowBargeInMs)) codes.push("slow-barge-in");
  if (talkedAfterGoodbyeMs > t.talkedAfterGoodbyeMs) codes.push("talked-after-goodbye");
  if (deadAirMs.some((ms) => ms > t.deadAirMs)) codes.push("dead-air");
  const repromptCount = timeline.events.filter((e) => e.event === "callee-reprompt").length;
  if (repromptCount > 0) codes.push("callee-reprompted");

  return {
    responseGapsMs,
    p50,
    p90,
    overlapsMs,
    bargeInStopsMs,
    backchannelsMs,
    spokeBeforeCallee,
    talkedAfterGoodbyeMs,
    deadAirMs,
    repromptCount,
    codes
  };
}

const ms = z.number().finite().nonnegative();
const thresholdsSchema = z
  .object({
    slowResponseP50Ms: ms,
    slowResponseP90Ms: ms,
    talkOverMs: ms,
    slowBargeInMs: ms,
    talkedAfterGoodbyeMs: ms,
    deadAirMs: ms,
    bargeInMinCalleeMs: ms
  })
  .strict();

/** Strictly validates a thresholds object: every key, no others. */
export function parseThresholds(value: unknown): Thresholds {
  return thresholdsSchema.parse(value);
}

/** Reads and validates `configs/thresholds.json` (or another path). */
export function loadThresholds(path: string): Thresholds {
  return parseThresholds(JSON.parse(readFileSync(path, "utf8")));
}

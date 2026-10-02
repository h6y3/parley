import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { muLawDecode, muLawEncode } from "@parley/audio";
import type { Timeline } from "../src/capture.js";
import {
  analyzeTiming,
  loadThresholds,
  parseThresholds,
  segments,
  type Thresholds
} from "../src/timing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RATE = 8000;
const at = (ms: number): number => Math.round((ms * RATE) / 1000);

const DEFAULTS: Thresholds = {
  slowResponseP50Ms: 1500,
  slowResponseP90Ms: 2500,
  talkOverMs: 300,
  slowBargeInMs: 800,
  talkedAfterGoodbyeMs: 1500,
  deadAirMs: 4000,
  bargeInMinCalleeMs: 600
};

/** Deterministic PRNG (mulberry32), so the noise fixtures never flake. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Burst = [startMs: number, endMs: number];

interface ChannelSpec {
  bursts?: Burst[];
  /** Tone level, dBFS RMS. */
  toneDb?: number;
  hz?: number[];
  /** Comfort-noise floor, dBFS RMS; omitted = digital silence. */
  noiseDb?: number;
  seed?: number;
}

/** One mono channel of sine bursts over optional Gaussian line noise, put
 * through a μ-law round trip as the phone leg does. */
function channel(totalMs: number, spec: ChannelSpec): Int16Array {
  const n = at(totalMs);
  const f = new Float64Array(n);
  if (spec.noiseDb !== undefined) {
    const rand = rng(spec.seed ?? 1);
    const sigma = 32768 * 10 ** (spec.noiseDb / 20);
    for (let i = 0; i < n; i++) {
      const u = Math.max(rand(), 1e-12);
      f[i] = sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    }
  }
  const hz = spec.hz ?? [440];
  const amp = (32768 * 10 ** ((spec.toneDb ?? -15) / 20) * Math.SQRT2) / hz.length;
  for (const [s, e] of spec.bursts ?? []) {
    for (let i = at(s); i < Math.min(at(e), n); i++) {
      for (const h of hz) f[i] += amp * Math.sin((2 * Math.PI * h * i) / RATE);
    }
  }
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i])));
  return muLawDecode(muLawEncode(pcm));
}

function stereo(agent: Int16Array, callee: Int16Array): Buffer {
  const n = agent.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(agent[i], i * 4);
    data.writeInt16LE(callee[i], i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function call(
  totalMs: number,
  agent: Burst[],
  callee: Burst[],
  opts: { noiseDb?: number; agentHz?: number[] } = {}
): Buffer {
  return stereo(
    channel(totalMs, { bursts: agent, hz: opts.agentHz, noiseDb: opts.noiseDb, seed: 11 }),
    channel(totalMs, { bursts: callee, hz: [300], noiseDb: opts.noiseDb, seed: 23 })
  );
}

function timeline(events: { atMs: number; event: string }[] = []): Timeline {
  return {
    startedAtMs: 0,
    sampleRate: 8000,
    channels: { agent: "L", callee: "R" },
    events,
    calleeText: []
  };
}

function expectNear(actual: number, expected: number, tol = 40): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

describe("segments", () => {
  it("finds no speech in a -50 dBFS comfort-noise floor", () => {
    expect(segments(channel(10_000, { noiseDb: -50, seed: 7 }), 8000)).toEqual([]);
  });

  it("finds no speech in digital silence", () => {
    expect(segments(new Int16Array(at(5000)), 8000)).toEqual([]);
  });

  it("detects speech over line noise within ±40 ms", () => {
    const bursts: Burst[] = [
      [1013, 2507],
      [3210, 3900],
      [5007, 5163],
      [7333, 9871]
    ];
    const found = segments(channel(12_000, { bursts, noiseDb: -50, seed: 3 }), 8000);
    expect(found).toHaveLength(bursts.length);
    found.forEach((seg, i) => {
      expectNear(seg.startMs, bursts[i][0]);
      expectNear(seg.endMs, bursts[i][1]);
    });
  });

  it("tracks the floor: speech 16 dB over a -40 dBFS floor is found, 8 dB over is not", () => {
    // At a -40 dBFS floor the -45 dBFS minimum is not the binding term.
    const loud = channel(10_000, { bursts: [[2000, 4000]], toneDb: -24, noiseDb: -40, seed: 5 });
    const found = segments(loud, 8000);
    expect(found).toHaveLength(1);
    expectNear(found[0].startMs, 2000);
    expectNear(found[0].endMs, 4000);
    const quiet = channel(10_000, { bursts: [[2000, 4000]], toneDb: -32, noiseDb: -40, seed: 5 });
    expect(segments(quiet, 8000)).toEqual([]);
  });

  it("drops bursts under 120 ms and merges gaps under 200 ms", () => {
    const pcm = channel(6000, {
      bursts: [
        [500, 580], // 80 ms click: dropped
        [1000, 1500],
        [1660, 2000], // 160 ms gap: merged
        [2400, 2800] // 400 ms gap: separate
      ]
    });
    expect(segments(pcm, 8000)).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 2400, endMs: 2800 }
    ]);
  });

  it("joins short syllables into one segment before the minimum-length check", () => {
    // Three 100 ms syllables 100 ms apart are one 500 ms utterance, not three clicks.
    const pcm = channel(3000, {
      bursts: [
        [1000, 1100],
        [1200, 1300],
        [1400, 1500]
      ]
    });
    expect(segments(pcm, 8000)).toEqual([{ startMs: 1000, endMs: 1500 }]);
  });
});

describe("analyzeTiming", () => {
  it("measures response gaps and their p50/p90", () => {
    const wav = call(
      10_000,
      [
        [2300, 3300],
        [7000, 8000]
      ],
      [
        [500, 1500],
        [4000, 5000]
      ]
    );
    const r = analyzeTiming(wav, timeline(), DEFAULTS);
    expect(r.responseGapsMs).toEqual([800, 2000]);
    expect(r.p50).toBe(800);
    expect(r.p90).toBe(2000);
    // Neither 800 nor 2000 crosses the default 1500/2500.
    expect(r.codes).not.toContain("slow-response");
    // p90 alone trips slow-response once its threshold is under 2000.
    const tight = analyzeTiming(wav, timeline(), { ...DEFAULTS, slowResponseP90Ms: 1900 });
    expect(tight.codes).toEqual(["slow-response"]);
  });

  it("flags slow-response on p90 at the default thresholds", () => {
    const wav = call(
      14_000,
      [
        [2300, 3300],
        [7800, 8800]
      ],
      [
        [500, 1500],
        [4000, 5000]
      ]
    );
    const r = analyzeTiming(wav, timeline(), DEFAULTS);
    expect(r.responseGapsMs).toEqual([800, 2800]);
    expect(r.p50).toBe(800);
    expect(r.codes).toEqual(["slow-response"]);
  });

  it("does not count a gap when the callee keeps talking before the agent answers", () => {
    const wav = call(
      8000,
      [[3500, 4500]],
      [
        [500, 1500],
        [2000, 3000]
      ]
    );
    expect(analyzeTiming(wav, timeline(), DEFAULTS).responseGapsMs).toEqual([500]);
  });

  it("flags an agent burst before any callee burst as spoke-before-callee", () => {
    const early = analyzeTiming(
      call(
        6000,
        [
          [200, 1000],
          [3000, 4000]
        ],
        [[1500, 2500]]
      ),
      timeline(),
      DEFAULTS
    );
    expect(early.spokeBeforeCallee).toBe(true);
    expect(early.codes).toContain("spoke-before-callee");

    const polite = analyzeTiming(call(6000, [[3000, 4000]], [[1500, 2500]]), timeline(), DEFAULTS);
    expect(polite.spokeBeforeCallee).toBe(false);
    expect(polite.codes).toEqual([]);
  });

  it("ignores line hiss: noise on both channels yields no talk-over or spoke-before-callee", () => {
    const r = analyzeTiming(
      call(8000, [[3000, 4000]], [[1000, 2400]], { noiseDb: -50 }),
      timeline(),
      DEFAULTS
    );
    expect(r.spokeBeforeCallee).toBe(false);
    expect(r.overlapsMs).toEqual([]);
    expect(r.codes).toEqual([]);
    expect(r.responseGapsMs).toHaveLength(1);
    expectNear(r.responseGapsMs[0], 600);
  });

  it("counts a reply that starts just before the callee's end (under talk-over) as gap 0", () => {
    // The agent comes in 200 ms early: fast endpointing, not talk-over.
    const r = analyzeTiming(
      call(
        10_000,
        [
          [2800, 3800],
          [6800, 7800]
        ],
        [
          [1000, 3000],
          [5000, 6000]
        ]
      ),
      timeline(),
      DEFAULTS
    );
    expect(r.responseGapsMs).toHaveLength(2);
    expect(r.responseGapsMs[0]).toBe(0);
    expectNear(r.responseGapsMs[1], 800);
    expect(r.p50).toBe(0);
    expect(r.codes).toEqual([]);
  });

  it("flags a 500 ms agent-initiated overlap as talk-over", () => {
    const r = analyzeTiming(call(6000, [[2500, 3500]], [[1000, 3000]]), timeline(), DEFAULTS);
    expect(r.overlapsMs).toEqual([500]);
    expect(r.codes).toEqual(["talk-over"]);
    // A talk-over is not a fast reply: no gap is recorded for it.
    expect(r.responseGapsMs).toEqual([]);
  });

  it("does not flag a callee-initiated overlap as talk-over", () => {
    const r = analyzeTiming(
      call(
        6000,
        [[1000, 3000]],
        [
          [100, 600],
          [2500, 3500]
        ]
      ),
      timeline(),
      DEFAULTS
    );
    expect(r.overlapsMs).toEqual([500]);
    expect(r.bargeInStopsMs).toEqual([500]);
    expect(r.codes).toEqual([]);
  });

  it("flags a 1200 ms barge-in stop as slow-barge-in", () => {
    // A 900 ms callee turn inside the agent's segment is a real barge-in.
    const r = analyzeTiming(
      call(
        6000,
        [[1500, 4000]],
        [
          [100, 600],
          [2800, 3700]
        ]
      ),
      timeline(),
      DEFAULTS
    );
    expect(r.bargeInStopsMs).toEqual([1200]);
    expect(r.backchannelsMs).toEqual([]);
    expect(r.codes).toEqual(["slow-barge-in"]);
  });

  it("treats a short callee overlap inside a long agent turn as a backchannel", () => {
    // "mm-hm" during a 5 s agent turn: talking through it is correct.
    const r = analyzeTiming(
      call(
        9000,
        [[1000, 6000]],
        [
          [100, 600],
          [3000, 3300]
        ]
      ),
      timeline(),
      DEFAULTS
    );
    expect(r.backchannelsMs).toEqual([300]);
    expect(r.bargeInStopsMs).toEqual([]);
    expect(r.overlapsMs).toEqual([300]);
    expect(r.codes).not.toContain("slow-barge-in");
  });

  it("counts a short callee overlap that runs past the agent's end as a barge-in", () => {
    // 300 ms callee burst starting 200 ms before the agent stops.
    const r = analyzeTiming(
      call(
        6000,
        [[1000, 3000]],
        [
          [100, 600],
          [2800, 3100]
        ]
      ),
      timeline(),
      DEFAULTS
    );
    expect(r.bargeInStopsMs).toEqual([200]);
    expect(r.backchannelsMs).toEqual([]);
  });

  describe("agent DTMF tones", () => {
    const dtmf = [697, 1209]; // the "1" key
    const wav = call(
      6000,
      [
        [200, 400], // a keypress before the callee speaks
        [1500, 1700] // a keypress over the menu prompt
      ],
      [[800, 3000]],
      { agentHz: dtmf }
    );

    it("does not count in-band keypresses as talk-over or spoke-before-callee", () => {
      const events = [
        { atMs: 350, event: "dtmf:1" },
        { atMs: 1650, event: "dtmf:1" }
      ];
      const r = analyzeTiming(wav, timeline(events), DEFAULTS);
      expect(r.spokeBeforeCallee).toBe(false);
      expect(r.overlapsMs).toEqual([]);
      expect(r.codes).toEqual([]);
    });

    it("still counts the same energy as speech when no keypress was reported", () => {
      const r = analyzeTiming(wav, timeline(), DEFAULTS);
      expect(r.spokeBeforeCallee).toBe(true);
      expect(r.codes).toContain("spoke-before-callee");
    });

    it("only excuses energy within 300 ms of the reported keypress", () => {
      const r = analyzeTiming(wav, timeline([{ atMs: 1000, event: "dtmf:1" }]), DEFAULTS);
      expect(r.spokeBeforeCallee).toBe(true);
    });
  });

  it("anchors goodbye on the callee-goodbye event, or the callee's last segment end", () => {
    const wav = call(
      12_000,
      [
        [2000, 3000],
        [6500, 8500]
      ],
      [
        [500, 1500],
        [4000, 6000]
      ]
    );
    // No event: anchor is the callee's last segment end (6000).
    const fallback = analyzeTiming(wav, timeline(), DEFAULTS);
    expect(fallback.talkedAfterGoodbyeMs).toBe(2000);
    expect(fallback.codes).toEqual(["talked-after-goodbye"]);

    // The bot hung up at 7500: only 1000 ms of agent speech follows it.
    const late = analyzeTiming(wav, timeline([{ atMs: 7500, event: "callee-goodbye" }]), DEFAULTS);
    expect(late.talkedAfterGoodbyeMs).toBe(1000);
    expect(late.codes).toEqual([]);

    // The event fires while the goodbye is still playing: the anchor is the
    // end of that audio, not the moment the tool was called.
    const mid = analyzeTiming(wav, timeline([{ atMs: 4500, event: "callee-goodbye" }]), DEFAULTS);
    expect(mid.talkedAfterGoodbyeMs).toBe(2000);
  });

  it("flags mutual silence over 4 s mid-call as dead air, but not silence after goodbye", () => {
    const wav = call(
      20_000,
      [
        [2000, 3000],
        [8000, 9000]
      ],
      [
        [500, 1500],
        [3500, 4000],
        [10_000, 10_500]
      ]
    );
    const r = analyzeTiming(wav, timeline(), DEFAULTS);
    // 4000 ms is the limit, not over it; the 10 s tail after goodbye is not counted.
    expect(r.deadAirMs).toEqual([500, 500, 4000, 1000]);
    expect(r.codes).not.toContain("dead-air");

    const longer = analyzeTiming(
      call(
        20_000,
        [
          [2000, 3000],
          [9000, 9500]
        ],
        [
          [500, 1500],
          [3500, 4000],
          [10_000, 10_500]
        ]
      ),
      timeline(),
      DEFAULTS
    );
    expect(longer.deadAirMs).toEqual([500, 500, 5000, 500]);
    // The same silence is also a 5 s response gap.
    expect(longer.codes).toEqual(["slow-response", "dead-air"]);
  });

  it("reports zeros, not NaN, for a call with no exchanges", () => {
    const r = analyzeTiming(call(3000, [], []), timeline(), DEFAULTS);
    expect(r).toEqual({
      responseGapsMs: [],
      p50: 0,
      p90: 0,
      overlapsMs: [],
      bargeInStopsMs: [],
      backchannelsMs: [],
      spokeBeforeCallee: false,
      talkedAfterGoodbyeMs: 0,
      deadAirMs: [],
      repromptCount: 0,
      codes: []
    });
  });

  it("codes callee-reprompted, with a count, when the callee had to say hello again", () => {
    // The callee's hello, a reprompt into silence, its second hello, then the
    // agent answers: the gap before the second hello is dropped, so only the
    // timeline can show the agent was silent.
    const wav = call(
      8000,
      [[5000, 6000]],
      [
        [0, 800],
        [3900, 4500]
      ]
    );
    const once = analyzeTiming(wav, timeline([{ atMs: 3800, event: "callee-reprompt" }]), DEFAULTS);
    expect(once.repromptCount).toBe(1);
    expect(once.codes).toContain("callee-reprompted");
    expect(once.deadAirMs.every((ms) => ms <= DEFAULTS.deadAirMs)).toBe(true);
    const twice = analyzeTiming(
      wav,
      timeline([
        { atMs: 3800, event: "callee-reprompt" },
        { atMs: 7000, event: "callee-reprompt" }
      ]),
      DEFAULTS
    );
    expect(twice.repromptCount).toBe(2);
    expect(twice.codes.filter((c) => c === "callee-reprompted")).toHaveLength(1);
    const none = analyzeTiming(wav, timeline(), DEFAULTS);
    expect(none.repromptCount).toBe(0);
    expect(none.codes).not.toContain("callee-reprompted");
  });

  it("rejects a capture that is not stereo 8 kHz", () => {
    const wav = call(1000, [], []);
    wav.writeUInt16LE(1, 22);
    expect(() => analyzeTiming(wav, timeline(), DEFAULTS)).toThrow(/stereo/);
  });
});

describe("loadThresholds", () => {
  it("reads the shipped initial values", () => {
    expect(loadThresholds(join(root, "configs", "thresholds.json"))).toEqual(DEFAULTS);
  });

  it("rejects a missing or unknown key", () => {
    expect(() => parseThresholds({ ...DEFAULTS, deadAirMs: undefined })).toThrow();
    expect(() => parseThresholds({ ...DEFAULTS, extra: 1 })).toThrow();
    expect(() => parseThresholds({ ...DEFAULTS, talkOverMs: -1 })).toThrow();
  });
});

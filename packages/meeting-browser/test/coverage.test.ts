import { describe, expect, it } from "vitest";
import { createFrameCoverageClock, measureCoverage } from "../src/coverage.js";

const T0 = 1_755_000_000_000;

describe("measureCoverage", () => {
  /** The window opens when the capture did, not when the meeting did. The
   * span before it — waiting room, admission, switching captions on — is
   * counted by neither field, which is exactly what the record schema says
   * about the telephony transport's own pre-consent time. */
  it("does not count the minutes before the capture started as audio it can vouch for", () => {
    const coverage = measureCoverage({
      t0: T0,
      captureStartedAtMs: T0 + 120_000, // two minutes in a waiting room
      lastFrameAtMs: T0 + 3_720_000,
      endedAtMs: T0 + 3_720_200
    });
    expect(coverage.coveredMs).toBe(3_600_000);
    expect(coverage.gapMs).toBe(200);
    // The sum spans the capture window, not the meeting — and that shortfall
    // is the pre-capture span, not missing data.
    const durationMs = 3_720_200;
    expect(coverage.coveredMs + coverage.gapMs).toBeLessThan(durationMs);
  });

  /** The number that used to be impossible to write down. A capture that
   * died two minutes into an hour reported the full hour as covered with no
   * holes; now the fifty-eight minutes nobody recorded are a gap. */
  it("reports the remainder as a gap when the capture dies mid-meeting", () => {
    const coverage = measureCoverage({
      t0: T0,
      captureStartedAtMs: T0,
      lastFrameAtMs: T0 + 120_000,
      endedAtMs: T0 + 3_600_000
    });
    expect(coverage.coveredMs).toBe(120_000);
    expect(coverage.gapMs).toBe(3_480_000);
  });

  /** No window ever opened, so there is nothing to divide into covered and
   * uncovered — and `gapMs: 0` would say "no holes" about a meeting where
   * nothing whatsoever was recorded. The whole meeting is the gap. */
  it("calls the whole meeting a gap when the capture never started", () => {
    const coverage = measureCoverage({
      t0: T0,
      captureStartedAtMs: null,
      lastFrameAtMs: null,
      endedAtMs: T0 + 600_000
    });
    expect(coverage.coveredMs).toBe(0);
    expect(coverage.gapMs).toBe(600_000);
  });

  it("vouches for nothing when the capture started and no frame ever arrived", () => {
    const coverage = measureCoverage({
      t0: T0,
      captureStartedAtMs: T0 + 10_000,
      lastFrameAtMs: null,
      endedAtMs: T0 + 610_000
    });
    expect(coverage.coveredMs).toBe(0);
    expect(coverage.gapMs).toBe(600_000);
  });

  /** A clock that steps backwards must not produce a negative duration in a
   * field the schema declares nonnegative — the record would be rejected at
   * `buildMeetingRecord` and the meeting would lose its evidence entirely. */
  it("never reports a negative span", () => {
    const coverage = measureCoverage({
      t0: T0,
      captureStartedAtMs: T0 + 5000,
      lastFrameAtMs: T0 + 4000,
      endedAtMs: T0 + 1000
    });
    expect(coverage.coveredMs).toBe(0);
    expect(coverage.gapMs).toBe(0);
  });
});

describe("createFrameCoverageClock", () => {
  it("remembers when the last frame went past, and passes every frame through", async () => {
    let clock = T0;
    const meter = createFrameCoverageClock(() => clock);
    expect(meter.lastFrameAtMs).toBeNull();

    const seen: Buffer[] = [];
    for await (const frame of meter.meter(
      (async function* () {
        yield Buffer.from([1]);
        clock += 1000;
        yield Buffer.from([2]);
        clock += 1000;
      })()
    )) {
      seen.push(frame);
    }

    expect(seen).toHaveLength(2);
    // The SECOND frame's instant, and not the instant the stream ended: the
    // last frame is when audio stopped reaching the transcriber.
    expect(meter.lastFrameAtMs).toBe(T0 + 1000);
  });

  it("lets a stream failure through rather than swallowing it", async () => {
    const meter = createFrameCoverageClock(() => T0);
    const frames = (async function* () {
      yield Buffer.from([1]);
      throw new Error("audio tap lost the stream");
    })();
    await expect(async () => {
      for await (const frame of meter.meter(frames)) void frame;
    }).rejects.toThrow(/lost the stream/);
    // What did arrive still counts.
    expect(meter.lastFrameAtMs).toBe(T0);
  });
});

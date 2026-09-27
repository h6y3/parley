import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JoinOutcome, TranscriptEvent } from "@parley/core";
import { startAudioTap } from "../src/audio-tap.js";
import { TEARDOWN_STEP_TIMEOUT_MS, runBrowserMeeting } from "../src/session.js";
import type { SessionDeps } from "../src/session.js";
import { TranscriptionInterruptedError } from "../src/transcription-interrupted.js";
import { SIGTERM_HANDLING_CAPTURE, fakeFfmpeg } from "./fake-ffmpeg.js";

/** How long these tests make the ended signal have to hold before a meeting is
 * over. One second, which at `CAPTION_POLL_MS` is two consecutive readings —
 * the narrowest window the loop can express.
 *
 * Stated at every call site rather than inherited from the shipped default,
 * which is thirty seconds (`HAS_ENDED_CONFIRM_MS`, and its comment carries why)
 * and is not what any test in this file is about. Inherited, the whole file
 * would have to be re-timed the next time that number moves — and the number
 * has already moved once, after the two-poll version was found truncating real
 * meetings on a four-second page blackout. */
const SHORT_ENDED_CONFIRM_SECONDS = 1;

/** A tap that yields nothing and stops cleanly, reporting its start on the
 * clock the test is using. `startedAtMs` is not decoration: it is the origin
 * of the record's coverage window (`SessionDeps.startTap`), so a fake that
 * read a different clock than the session would produce coverage numbers no
 * real run could. */
function silentTap(
  now: () => number,
  stop: () => Promise<void> = async () => {}
): { frames: AsyncIterable<Buffer>; stop(): Promise<void>; startedAtMs: number } {
  return { frames: (async function* () {})(), stop, startedAtMs: now() };
}

function deps(overrides: Record<string, unknown> = {}): SessionDeps {
  const now = (overrides.now as (() => number) | undefined) ?? ((): number => 1_755_000_000_000);
  return {
    openPage: async () => ({}),
    closePage: vi.fn(async () => {}),
    adapter: {
      id: "fake",
      join: async () => "admitted",
      ensureCaptions: async () => true,
      readCaptions: async () => [],
      readRoster: async () => ["Priya"],
      hasEnded: async () => true,
      leave: vi.fn(async () => {})
    },
    startTap: vi.fn(() => silentTap(now)),
    transcribe: async () => [],
    now,
    dispatchPostCall: vi.fn(async () => null),
    ...overrides
  } as SessionDeps;
}

async function readRecord(recordsPath: string): Promise<Record<string, unknown>> {
  const line = (await readFile(recordsPath, "utf8")).trim();
  return JSON.parse(line) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runBrowserMeeting", () => {
  it("does NOT start the audio tap when the join was not admitted", async () => {
    // Decision 4. The tap captures ALL system audio; started on a failed join
    // it would transcribe the room the host machine is sitting in.
    const d = deps({
      adapter: { ...deps().adapter, join: async () => "denied" }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    expect(d.startTap).not.toHaveBeenCalled();
    expect(out.joinOutcome).toBe("denied");
    expect(out.transcriptPath).toBeNull();
  });

  it("starts the tap once admitted", async () => {
    const d = deps();
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    expect(d.startTap).toHaveBeenCalledOnce();
  });

  it("writes a record even when the join failed", async () => {
    const d = deps({ adapter: { ...deps().adapter, join: async () => "auth_required" } });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    expect(out.recordsPath).toBeTruthy();
  });

  /** The two calls that open the page and drive the join were the only awaits
   * in this module outside a guard, and they are the likeliest to throw in
   * the whole package: both are chains of browser round trips against
   * somebody else's single-page app, where a timeout or a rotated selector is
   * the ordinary failure rather than the exotic one. Unguarded, either one
   * rejected `runBrowserMeeting` outright and the attempt produced NO record
   * — invisible to a consumer that watches records, rather than failed. */
  it.each([
    {
      what: "opening the page",
      overrides: {
        openPage: async (): Promise<unknown> => {
          throw new Error("CDP target closed while opening a page");
        }
      }
    },
    {
      what: "driving the join",
      overrides: {
        adapter: {
          ...deps().adapter,
          join: async (): Promise<never> => {
            throw new Error("locator timeout waiting for the join control");
          }
        }
      }
    }
  ])("writes a record when $what throws, rather than none at all", async ({ overrides }) => {
    const dispatchPostCall = vi.fn(async () => null);
    const d = deps({ ...overrides, dispatchPostCall });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );

    // It RESOLVES rather than rejecting: the record, not the exception, is
    // this module's report.
    expect(out.captureFault?.message).toMatch(/CDP target closed|locator timeout/);
    // The tap captures all system audio and admission was never confirmed, so
    // it must not have started; and there is nothing truthful to put in a
    // transcript.
    expect(d.startTap).not.toHaveBeenCalled();
    expect(out.transcriptPath).toBeNull();

    const record = await readRecord(recordsPath);
    expect(record.status).toBe("never_joined");
    // The outcome that means "the attempt threw, so there is no verdict". It
    // was `waiting_room_timeout` here, which made that one value cover three
    // different things — a genuine lobby timeout, a successful join whose
    // in-call markers went unrecognised, and this. The distinctness is the
    // point, so it is asserted as a distinctness and not only as a value.
    expect(record.joinOutcome).toBe("join_error");
    expect(out.joinOutcome).toBe("join_error");
    expect(record.joinOutcome).not.toBe("waiting_room_timeout");
    expect(record.endedReason).toBe("transcription_lost");
    // And the attempt reached the hook, like every other attempt does.
    expect(dispatchPostCall).toHaveBeenCalledOnce();
  });

  /** A join that RETURNS `waiting_room_timeout` must still say so. Splitting
   * the throw out of that value is only worth anything if the value keeps
   * meaning what it always meant on the path that legitimately produces it —
   * otherwise the two cases have swapped places rather than separated. */
  it("still writes waiting_room_timeout when the join returns it rather than throwing", async () => {
    const d = deps({
      adapter: {
        ...deps().adapter,
        join: async (): Promise<JoinOutcome> => "waiting_room_timeout"
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );

    expect(out.joinOutcome).toBe("waiting_room_timeout");
    expect(out.captureFault).toBeNull();
    const record = await readRecord(recordsPath);
    expect(record.joinOutcome).toBe("waiting_room_timeout");
    expect(record.status).toBe("never_joined");
  });

  /** A deps object whose two teardown steps announce themselves, in order,
   * on top of whatever the case under test overrides. */
  function tracedDeps(order: string[], overrides: Record<string, unknown> = {}): SessionDeps {
    const base = deps(overrides);
    return {
      ...base,
      closePage: async (page: unknown) => {
        order.push("closePage");
        await base.closePage(page);
      },
      adapter: {
        ...base.adapter,
        leave: async (page: unknown) => {
          order.push("leave");
          await base.adapter.leave(page);
        }
      }
    };
  }

  /** The notetaker's presence in the participant list is bounded by nothing
   * else. `leaveCallButton` was defined in the adapter and never clicked, and
   * the page was never closed — only the CDP connection was dropped. So after
   * ANY ending it stayed in the room, under the display name that is the
   * room's only disclosure that a notetaker is present, no longer recording
   * anything, with the owning process gone and no way to remove it but by
   * hand.
   *
   * Every ending, because "on teardown" is not a property of one path: a
   * meeting that outran the ceiling and one whose page threw on the way in
   * are both endings, and the second one leaves a notetaker in the room just
   * as surely. */
  it.each([
    { ending: "a join that was never admitted", overrides: { join: async () => "denied" } },
    { ending: "the room ending the meeting", overrides: {} },
    {
      ending: "a caption fault mid-meeting",
      overrides: {
        readCaptions: async (): Promise<never> => {
          throw new Error("captions region gone");
        }
      }
    }
  ])("leaves the meeting and closes its page after $ending", async ({ overrides }) => {
    const order: string[] = [];
    const d = tracedDeps(order, { adapter: { ...deps().adapter, ...overrides } });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );

    // The click first — it is the graceful exit and the one the room sees —
    // then the close, which is what actually guarantees departure.
    expect(order).toEqual(["leave", "closePage"]);
    // And the record was still written: teardown is not a substitute for
    // evidence.
    expect(await readRecord(recordsPath)).toMatchObject({ transport: "browser" });
  });

  it("leaves the meeting and closes its page when the duration ceiling ends it", async () => {
    // The one ending where a notetaker left behind is GUARANTEED rather than
    // hypothetical: the room is still meeting, so nothing else will ever
    // remove it.
    vi.useFakeTimers();
    const order: string[] = [];
    const d = tracedDeps(order, {
      now: () => Date.now(),
      adapter: { ...deps().adapter, hasEnded: async () => false }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        maxMeetingSeconds: 2,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    expect(order).toEqual(["leave", "closePage"]);
    expect((await readRecord(recordsPath)).endedReason).toBe("duration_cap");
  });

  it("leaves and closes even when the join itself threw, and even when there is no page to close", async () => {
    // A throw from `join` happens with the transport possibly already IN the
    // room — `joinMeeting` calls hasEnded after the click and after admission
    // is confirmed — so this is the case where being left behind is likeliest
    // and least visible.
    const order: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const config = {
      url: "https://example.test/x",
      displayName: "Notetaker",
      chromeProfileDir: dir,
      recordsPath: join(dir, "r.jsonl"),
      transcriptsDir: dir,
      endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
    };
    await runBrowserMeeting(
      config,
      tracedDeps(order, {
        adapter: {
          ...deps().adapter,
          join: async (): Promise<never> => {
            throw new Error("locator timeout after the join click");
          }
        }
      })
    );
    expect(order).toEqual(["leave", "closePage"]);

    // And the other side of it: a page that never opened must not be left
    // for, or closed. There is nothing there to act on and pretending
    // otherwise would turn every unreachable Chrome into two more failures.
    const noPage: string[] = [];
    await runBrowserMeeting(
      config,
      tracedDeps(noPage, {
        openPage: async (): Promise<never> => {
          throw new Error("no browser context to open a page in");
        }
      })
    );
    expect(noPage).toEqual([]);
  });

  it("writes the record when leaving fails, and reports the failure rather than throwing it", async () => {
    // Failing to get out is not a reason to lose the meeting. It is also not
    // a reason to skip the close — which is the step that actually removes
    // the participant, and therefore the one that must survive a failed
    // click.
    const order: string[] = [];
    const d = tracedDeps(order, {
      adapter: {
        ...deps().adapter,
        leave: async (): Promise<never> => {
          throw new Error("leave control did not respond");
        }
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );

    expect(order).toEqual(["leave", "closePage"]);
    expect(out.captureFault?.message).toMatch(/leave control did not respond/);
    // The meeting itself was fine and is recorded as such: a teardown fault
    // does not rewrite how the meeting went.
    const record = await readRecord(recordsPath);
    expect(record.status).toBe("completed");
    expect(record.endedReason).toBe("far_end");
    expect(out.transcriptPath).not.toBeNull();
  });

  it("dispatches the injected post-call hook on a denied join", async () => {
    // The hook is what turns a record into something a human sees, and a
    // join that never succeeded is exactly the event most worth reporting —
    // dispatch must not be conditioned on admission.
    const dispatchPostCall = vi.fn(async () => null);
    const d = deps({
      adapter: { ...deps().adapter, join: async () => "denied" },
      dispatchPostCall
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    expect(dispatchPostCall).toHaveBeenCalledOnce();
    expect(dispatchPostCall).toHaveBeenCalledWith(
      out.recordsPath,
      expect.stringMatching(/^MTG1755000000000-[0-9a-f]{8}$/)
    );
    // The id the hook is handed and the id in the record are the same value,
    // which is the property that actually matters to a consumer.
    const record = await readRecord(recordsPath);
    expect(dispatchPostCall).toHaveBeenCalledWith(out.recordsPath, record.callId);
  });

  it("gives two meetings that start in the same millisecond different ids", async () => {
    // MTG${t0} was the whole id. Two joins from one scheduler tick got the
    // same one, and the id is both the record's callId and the argument the
    // post-call hook is dispatched with — so a collision merged two meetings
    // into one for every consumer downstream, silently.
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const config = {
      url: "https://example.test/x",
      displayName: "Notetaker",
      chromeProfileDir: dir,
      recordsPath: join(dir, "r.jsonl"),
      transcriptsDir: dir,
      endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
    };
    // The same injected clock for both runs: identical t0, by construction.
    const first = await runBrowserMeeting(config, deps());
    const second = await runBrowserMeeting(config, deps());
    const [a, b] = (await readFile(config.recordsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(a.startedAt).toBe(b.startedAt);
    expect(a.callId).not.toBe(b.callId);
    expect(first.recordsPath).toBe(second.recordsPath);
  });

  it("dispatches the injected post-call hook once artifacts are written on an admitted meeting", async () => {
    vi.useFakeTimers();
    const dispatchPostCall = vi.fn(async () => null);
    const d = deps({ now: () => Date.now(), dispatchPostCall });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;
    expect(dispatchPostCall).toHaveBeenCalledOnce();
    expect(dispatchPostCall).toHaveBeenCalledWith(
      out.recordsPath,
      expect.stringMatching(/^MTG\d+-[0-9a-f]{8}$/)
    );
  });

  it("checks hasEnded before readCaptions on every poll tick", async () => {
    // readCaptions throws once the in-call anchors are gone — that is the
    // deliberate "a missing container is not a quiet meeting" guard
    // (google-meet.ts). A loop that scraped captions before checking
    // hasEnded, or read them on a tick where hasEnded was true, would blow
    // up here immediately instead of quietly ending the meeting.
    vi.useFakeTimers();
    const readCaptions = vi.fn(async () => {
      throw new Error("readCaptions called on a tick where the anchors were already gone");
    });
    const d = deps({
      now: () => Date.now(),
      adapter: { ...deps().adapter, hasEnded: async () => true, readCaptions }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;
    expect(readCaptions).not.toHaveBeenCalled();
    expect(out.joinOutcome).toBe("admitted");
  });

  it("wires waitUntilMeetingEnded, and records endedReason far_end on a normal ending", async () => {
    vi.useFakeTimers();
    const d = deps({ now: () => Date.now() });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;
    expect(out.transcriptPath).not.toBeNull();
    const record = await readRecord(recordsPath);
    expect(record.endedReason).toBe("far_end");
    expect(record.status).toBe("completed");
  });

  /** The ceiling used to be a clock comparison at the top of the caption
   * loop, so it could only fire if that loop was still going round — and
   * every other line of that loop is a browser round trip with no default
   * timeout. A wedged renderer parked the loop and the ceiling, the thing
   * protecting against a runaway browser on a shared host, was never
   * evaluated again. Nothing else would have ended this run: the ended-poll
   * is wedged on the same call.
   *
   * The bounded teardown is the other half and is asserted here too. A
   * ceiling that fires on time and then hangs one line later, waiting on the
   * same page that stopped answering, is the same defect moved rather than
   * fixed. */
  it("ends at the ceiling even when the page has stopped answering entirely", async () => {
    vi.useFakeTimers();
    const wedged = new Promise<never>(() => {
      // Never settles. A renderer that has stopped answering does not
      // reject — it simply does not come back, which is why no `catch`
      // anywhere in this module can see it.
    });
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        hasEnded: () => wedged,
        readCaptions: () => wedged
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        maxMeetingSeconds: 2,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    // The ceiling, then both loop waits giving up in turn.
    await vi.advanceTimersByTimeAsync(2000 + 3 * TEARDOWN_STEP_TIMEOUT_MS);
    const out = await promise;

    const record = await readRecord(recordsPath);
    expect(record.endedReason).toBe("duration_cap");
    expect(record.status).toBe("completed");
    // Giving up on the page is reported, never silent.
    expect(out.captureFault?.message).toMatch(/did not stop within/);
  });

  it("disarms the ceiling when the meeting ends any other way", async () => {
    // Two hours by default. An abandoned timer holds the event loop open for
    // the rest of it on every meeting that ends normally — a `parley` that
    // records the meeting correctly and then does not exit.
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      deps({ now: () => Date.now() })
    );
    await vi.advanceTimersByTimeAsync(3000);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records endedReason duration_cap when the ceiling is hit and the room never ends the meeting", async () => {
    vi.useFakeTimers();
    const d = deps({
      now: () => Date.now(),
      adapter: { ...deps().adapter, hasEnded: async () => false }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        maxMeetingSeconds: 2,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(6000);
    const out = await promise;
    expect(out.transcriptPath).not.toBeNull();
    const record = await readRecord(recordsPath);
    expect(record.endedReason).toBe("duration_cap");
    expect(record.status).toBe("completed");
  });

  it("records endedReason transcription_lost when the audio pipeline dies, distinct from a normal ending", async () => {
    vi.useFakeTimers();
    const d = deps({
      now: () => Date.now(),
      adapter: { ...deps().adapter, hasEnded: async () => false },
      transcribe: async () => {
        throw new Error("capture process exited 1");
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;
    // Admitted, so a transcript is still written (Decision: admission alone
    // decides transcriptPath, not how the meeting ended). Empty here because
    // this rejection carries nothing — a bare error says only that the
    // pipeline died, and inventing utterances for it would be worse than an
    // empty file. A failure that DID hear something is the test below.
    expect(out.transcriptPath).not.toBeNull();
    const record = await readRecord(recordsPath);
    expect(record.endedReason).toBe("transcription_lost");
    expect(record.status).toBe("completed");
  });

  /** A tap that dies at minute 55 of 60 used to throw away all 55 minutes:
   * the transcription plane only returns its events when the frame stream
   * ends, so the rejection took them with it and the session's own
   * `.catch(() => [])` wrote a header-only transcript. Both facts have to
   * survive — the meeting ended badly AND these words were said. */
  it("writes the utterances a mid-meeting capture failure had already heard", async () => {
    vi.useFakeTimers();
    const heard: TranscriptEvent[] = [
      {
        speaker: "participant",
        text: "the deadline slipped",
        startMs: 500,
        endMs: 1500,
        isFinal: true
      }
    ];
    const d = deps({
      now: () => Date.now(),
      adapter: { ...deps().adapter, hasEnded: async () => false },
      transcribe: async (): Promise<TranscriptEvent[]> => {
        throw new TranscriptionInterruptedError(
          new Error('audio tap exited 1 capturing device "Loopback"'),
          heard
        );
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;

    // The ending is still recorded as the failure it was: preserving the
    // words must not turn a broken meeting into a healthy one.
    expect((await readRecord(recordsPath)).endedReason).toBe("transcription_lost");
    const lines = (await readFile(out.transcriptPath as string, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]) as Record<string, unknown>).text).toBe("the deadline slipped");
  });

  it("leaves no ended-poll running once the duration ceiling wins the race", async () => {
    // waitUntilMeetingEnded is raced against the ceiling and the
    // transcription-failure observer. When either of those wins, this poll
    // never resolves on its own — and uncancelled it goes on calling
    // hasEnded, once per CAPTION_POLL_MS, on a page this module has finished
    // with, for the life of the process. One abandoned loop per meeting.
    //
    // hasEnded is counted rather than the poll being inspected: the caption
    // loop is already awaited to a stop before runBrowserMeeting returns, so
    // any call recorded AFTER it returns can only have come from the
    // ended-poll.
    vi.useFakeTimers();
    let hasEndedCalls = 0;
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        hasEnded: async () => {
          hasEndedCalls++;
          return false;
        }
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        maxMeetingSeconds: 2,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    const atReturn = hasEndedCalls;
    expect(atReturn).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hasEndedCalls).toBe(atReturn);

    // And the cancellation did not rewrite the ending: an abandoned poll
    // that RESOLVED would have recorded far_end on a run the ceiling ended.
    const record = await readRecord(recordsPath);
    expect(record.endedReason).toBe("duration_cap");
  });

  it("turns captions on before reading any", async () => {
    // Nothing in this package used to. Meet does not have captions on by
    // default, readCaptions throws when the region is absent, and hasEnded
    // cannot screen for it — so the first tick of every real join would have
    // killed the session.
    const order: string[] = [];
    const d = deps({
      adapter: {
        ...deps().adapter,
        ensureCaptions: async () => {
          order.push("ensureCaptions");
          return true;
        },
        hasEnded: async () => {
          order.push("hasEnded");
          return true;
        }
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    expect(order.filter((step) => step === "ensureCaptions")).toHaveLength(1);
    expect(order[0]).toBe("ensureCaptions");
    expect(out.captionsEnabled).toBe(true);
  });

  it("records the meeting WITHOUT attribution when captions cannot be enabled", async () => {
    // The degrade the whole captions change turns on. readCaptions must not
    // be called at all — it is required to throw rather than report an absent
    // region as a quiet room, so calling it here would end the meeting on its
    // first tick. The meeting instead runs to its normal ending and produces
    // a transcript with no speaker attribution.
    vi.useFakeTimers();
    const readCaptions = vi.fn(async () => {
      throw new Error("google-meet: captions region not found");
    });
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        ensureCaptions: async () => false,
        hasEnded: async () => false,
        readCaptions
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        maxMeetingSeconds: 2,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(6000);
    const out = await promise;

    expect(readCaptions).not.toHaveBeenCalled();
    expect(out.captionsEnabled).toBe(false);
    expect(out.captureFault).toBeNull();
    // A real transcript, and a normal ending — not transcription_lost.
    expect(out.transcriptPath).not.toBeNull();
    const record = await readRecord(recordsPath);
    expect(record.endedReason).toBe("duration_cap");
    expect(record.status).toBe("completed");
  });

  it("treats an ensureCaptions throw as captions unavailable, not as the end of the meeting", async () => {
    vi.useFakeTimers();
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        ensureCaptions: async () => {
          throw new Error("captions toggle not clickable");
        },
        hasEnded: async () => false
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        maxMeetingSeconds: 2,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(6000);
    const out = await promise;

    expect(out.captionsEnabled).toBe(false);
    expect((await readRecord(recordsPath)).endedReason).toBe("duration_cap");
  });

  it("still tears down and still writes a record when the ended-poll's hasEnded throws", async () => {
    // The SECOND caller of adapter.hasEnded, and the second route to the
    // defect the caption loop's guard closes. waitUntilMeetingEnded runs for
    // the meeting's whole remaining life; an unguarded rejection there
    // rejected the race and skipped the entire teardown just as surely.
    //
    // Isolated by switching captions off, so the caption loop never calls
    // hasEnded and the ended-poll is demonstrably the only caller.
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        ensureCaptions: async () => false,
        hasEnded: async () => {
          throw new Error("page closed");
        }
      },
      startTap: vi.fn(() => silentTap(Date.now, stop))
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;

    expect(stop).toHaveBeenCalledOnce();
    expect(out.captureFault?.message).toContain("page closed");
    expect((await readRecord(recordsPath)).endedReason).toBe("transcription_lost");
  });

  /** A caption scrape that fails loses ATTRIBUTION, and nothing else: the
   * tap and the transcriber are untouched by it. Ending the meeting there —
   * and recording it as `transcription_lost`, i.e. the transcriber having
   * died — traded the whole rest of the meeting's content for a signal that
   * can simply be reported. This module already models the identical loss as
   * a degrade when `ensureCaptions` returns false; the same loss thirty
   * seconds later is the same loss. */
  it("keeps recording the meeting when readCaptions throws, and reports the lost attribution", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    const dispatchPostCall = vi.fn(async () => null);
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        hasEnded: async () => false,
        readCaptions: async () => {
          throw new Error("google-meet: captions region not found");
        }
      },
      startTap: vi.fn(() => silentTap(Date.now, stop)),
      dispatchPostCall,
      transcribe: async (): Promise<TranscriptEvent[]> => [
        {
          speaker: "participant",
          text: "the deadline slipped",
          startMs: 500,
          endMs: 1500,
          isFinal: true
        }
      ]
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        maxMeetingSeconds: 2,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(6000);
    const out = await promise;

    expect(stop).toHaveBeenCalledOnce();
    expect(dispatchPostCall).toHaveBeenCalledOnce();
    // The loss is REPORTED — both halves. `captionsEnabled` is what a caller
    // reads before putting names in front of a human; the fault says why.
    expect(out.captionsEnabled).toBe(false);
    expect(out.captureFault?.message).toContain("captions region not found");

    const record = await readRecord(recordsPath);
    // The meeting ran to its own ceiling. NOT `transcription_lost`: the
    // transcriber never died, and a record saying it did would send a reader
    // looking for a broken pipeline that was working the whole time.
    expect(record.endedReason).toBe("duration_cap");
    expect(record.joinOutcome).toBe("admitted");
    // And the content the old behaviour threw away is here.
    const lines = (await readFile(out.transcriptPath as string, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("still tears down and still writes a record when hasEnded throws", async () => {
    // Same guard, the other adapter call on the same tick. hasEnded is what
    // decides whether the meeting is over at all, so a page that will not
    // answer it is not a meeting this module can keep driving.
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        hasEnded: async () => {
          throw new Error("page closed");
        }
      },
      startTap: vi.fn(() => silentTap(Date.now, stop))
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;

    expect(stop).toHaveBeenCalledOnce();
    expect(out.captureFault?.message).toContain("page closed");
    expect((await readRecord(recordsPath)).endedReason).toBe("transcription_lost");
  });

  /** Two properties of the caption degrade, in one place because they are
   * the same tick.
   *
   * Reading STOPS: `readCaptions` throws when the region is absent or its
   * selectors have rotated, and neither heals within a meeting, so a loop
   * that kept calling it would raise the same exception every second for the
   * rest of the call.
   *
   * And nothing is left polling afterwards: `endedWatch.abort()` sits after
   * the race, and this is a live meeting where both loops are still running
   * when the ceiling settles it. Uncancelled, the ended-poll goes on calling
   * `hasEnded` on a page this module has finished with, once per interval,
   * for the life of the process. */
  it("stops reading captions once they have failed, and leaves nothing polling after the meeting", async () => {
    vi.useFakeTimers();
    let readCalls = 0;
    let hasEndedCalls = 0;
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        hasEnded: async () => {
          hasEndedCalls++;
          return false;
        },
        readCaptions: async () => {
          readCalls++;
          throw new Error("google-meet: captions region not found");
        }
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        maxMeetingSeconds: 3,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(8000);
    await promise;

    expect(readCalls).toBe(1);
    const atReturn = hasEndedCalls;
    expect(atReturn).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hasEndedCalls).toBe(atReturn);
  });

  it("still writes a record when the audio tap cannot be started at all", async () => {
    // startTap() is called AFTER admission is confirmed, so a throw here is
    // a meeting we are sitting in with no capture. It used to reject
    // runBrowserMeeting outright and write nothing.
    vi.useFakeTimers();
    const dispatchPostCall = vi.fn(async () => null);
    const d = deps({
      now: () => Date.now(),
      startTap: vi.fn(() => {
        throw new Error("audio capture device not found");
      }),
      dispatchPostCall
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );

    expect(out.joinOutcome).toBe("admitted");
    expect(out.captureFault?.message).toContain("audio capture device not found");
    expect(dispatchPostCall).toHaveBeenCalledOnce();
    expect((await readRecord(recordsPath)).endedReason).toBe("transcription_lost");
  });

  it("reports no captureFault on a meeting that ended normally", async () => {
    // Guards the guard: a captureFault that was always populated, or an
    // endedReason that always read transcription_lost, would make every
    // assertion above pass for the wrong reason.
    vi.useFakeTimers();
    const d = deps({ now: () => Date.now() });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(3000);
    const out = await promise;
    expect(out.captureFault).toBeNull();
    expect((await readRecord(recordsPath)).endedReason).toBe("far_end");
  });

  it("leaves no timer armed once the caption loop has been cut short", async () => {
    // tickOrStop races a sleep against the stop signal. Promise.race settles
    // the promise and does nothing to the loser, so the abandoned setTimeout
    // stayed armed after teardown — holding the event loop open for up to a
    // full poll interval past the point the record was written and the tap
    // stopped. The transcription-failure branch is the sharpest way to reach
    // it: it resolves immediately, so the race settles while the caption loop
    // is still inside its very first sleep.
    //
    // Asserted on the timer count rather than on process exit, because that
    // is the thing that was wrong; join-driver's defaultWait already clears
    // its own timer on abort, so any survivor here is this loop's.
    vi.useFakeTimers();
    const d = deps({
      now: () => Date.now(),
      adapter: { ...deps().adapter, hasEnded: async () => false },
      transcribe: async () => {
        throw new Error("capture process exited 1");
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    // Deliberately NOT advanced past the poll interval: advancing would fire
    // the leaked timer and clear it, which is how this leak stayed invisible
    // to every other test in this file.
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  /** `coveredMs` was `endedAt - t0` and `gapMs` was `0`, unconditionally, so
   * every record claimed perfect coverage of its whole duration — including
   * the minutes spent in a waiting room before the capture existed. The
   * clock here is stepped by hand so those spans are exact rather than
   * approximately whatever the machine did. */
  it("counts only what the capture window covered, and calls the rest a gap", async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const d = deps({
      now: () => clock,
      // Forty-two seconds of waiting room, before any capture exists.
      openPage: async () => {
        clock += 42_000;
        return {};
      },
      transcribe: async (frames: AsyncIterable<Buffer>): Promise<TranscriptEvent[]> => {
        for await (const frame of frames) {
          void frame;
          clock += 10_000;
        }
        return [];
      },
      startTap: () => ({
        frames: (async function* () {
          yield Buffer.alloc(4);
          yield Buffer.alloc(4);
        })(),
        stop: async () => {},
        startedAtMs: clock
      })
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    const record = await readRecord(recordsPath);
    // Ten seconds of audio reached the transcriber (one frame to the next),
    // and ten more passed between the last frame and the end of the meeting.
    expect(record.coveredMs).toBe(10_000);
    expect(record.gapMs).toBe(10_000);
    // The waiting room is counted by NEITHER — the same accounting the record
    // schema describes for time before consent on the telephony transport.
    const durationMs = (record.durationSeconds as number) * 1000;
    expect(durationMs).toBe(62_000);
    expect((record.coveredMs as number) + (record.gapMs as number)).toBeLessThan(durationMs);
  });

  it("claims no coverage at all, and no clean run, when the tap never started", async () => {
    let clock = 1_000_000;
    const d = deps({
      now: () => clock,
      adapter: {
        ...deps().adapter,
        join: async () => {
          clock += 30_000;
          return "admitted";
        }
      },
      startTap: () => {
        throw new Error("audio capture device not found");
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );

    const record = await readRecord(recordsPath);
    expect(record.coveredMs).toBe(0);
    // Not zero. A meeting where nothing at all was recorded is a meeting that
    // is entirely hole, and `gapMs: 0` is what a consumer reads as "no holes".
    expect(record.gapMs).toBe(30_000);
  });

  /** Two speakers, one caption region, and the failure that puts one
   * person's words under another person's name.
   *
   * The adapter stamps every line currently on screen with the instant of the
   * scrape, and a line stays up for several seconds. So when Sam starts,
   * Priya's finished line is re-stamped with the SAME fresh instant as Sam's
   * new one — and the aligner's tie-break only prefers a strictly earlier
   * cue, so a tie is settled by DOM order, which the older line wins. Sam's
   * sentence is then published as Priya's, in a document a human quotes from.
   *
   * Both assertions below are load-bearing and fail for different reasons:
   * the second is what deduplication fixes, and the first is what keeping the
   * FIRST timestamp fixes (Priya's line is still on screen four polls after
   * she spoke, which is outside the aligner's three-second window). */
  it("attributes each speaker's words to that speaker, however long their caption stays on screen", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        readCaptions: async () => {
          calls++;
          // Wall-clock, re-read every scrape, exactly as `google-meet.ts`
          // does it — one `Date.now()` for every line on screen.
          const atMs = Date.now();
          const priya = { speaker: "Priya", text: "the deadline slipped", atMs };
          if (calls === 1) return [priya];
          return [priya, { speaker: "Sam", text: "can we ship friday", atMs }];
        },
        hasEnded: async () => calls > 5
      },
      transcribe: async (): Promise<TranscriptEvent[]> => [
        {
          speaker: "participant",
          text: "the deadline slipped",
          startMs: 100,
          endMs: 900,
          isFinal: true
        },
        {
          speaker: "participant",
          text: "can we ship friday",
          startMs: 1000,
          endMs: 1800,
          isFinal: true
        }
      ]
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(12_000);
    const out = await promise;

    const rows = (await readFile(out.transcriptPath as string, "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.map((r) => r.speakerId)).toEqual(["Priya", "Sam"]);
  });

  /** The whole point of this round, end to end, against a REAL capture
   * process: a meeting that ends normally must write down what was said in
   * it. Every other tap in this file is a fake whose frame stream ends by
   * itself, so none of them can see what stopping a live capture does — and
   * the real binary exits nonzero when it is stopped, which used to fail the
   * transcription and leave a header-only transcript under a record calling
   * itself complete.
   *
   * Real timers, because there is a child process here and a fake clock does
   * not make it produce frames any sooner. */
  it("writes what a normally-ended meeting heard, with a real capture stopped at teardown", async () => {
    const tap = startAudioTap({
      device: "TestDevice",
      ffmpegPath: await fakeFfmpeg(SIGTERM_HANDLING_CAPTURE)
    });
    let framesSeen = 0;
    const d = deps({
      now: () => Date.now(),
      startTap: () => ({ frames: tap.frames, stop: () => tap.stop(), startedAtMs: Date.now() }),
      // Shaped like the composition's own `transcribe` (`run.ts`): it
      // accumulates as frames arrive and carries what it heard out of a
      // failure. A fake returning a fixed array regardless of the stream
      // would pass whether that stream ended cleanly or blew up.
      transcribe: async (frames: AsyncIterable<Buffer>): Promise<TranscriptEvent[]> => {
        const events: TranscriptEvent[] = [];
        try {
          for await (const frame of frames) {
            framesSeen += 1;
            void frame;
            if (events.length === 0) {
              events.push({
                speaker: "participant",
                text: "the deadline slipped",
                startMs: 500,
                endMs: 1500,
                isFinal: true
              });
            }
          }
        } catch (error) {
          throw new TranscriptionInterruptedError(error, events);
        }
        return events;
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const recordsPath = join(dir, "r.jsonl");
    const out = await runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath,
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );

    expect(framesSeen).toBeGreaterThan(0);
    expect(out.captureFault).toBeNull();
    const record = await readRecord(recordsPath);
    expect(record.endedReason).toBe("far_end");
    expect(record.status).toBe("completed");

    const lines = (await readFile(out.transcriptPath as string, "utf8")).trim().split("\n");
    // A header AND an utterance. One line is the failure this round exists to
    // remove: a transcript with nothing in it, under a record that reads as a
    // complete meeting.
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]) as Record<string, unknown>).text).toBe("the deadline slipped");
  });

  it("converts caption cue times from wall-clock to milliseconds since t0 before attribution", async () => {
    // Constraint 4: the adapter deliberately reports wall-clock atMs; this
    // module must convert it to the session's own base before attribution
    // runs, or a real cue would never fall inside attributeEvents' alignment
    // window and would silently go unattributed.
    vi.useFakeTimers();
    const t0 = Date.now();
    let calls = 0;
    const d = deps({
      now: () => Date.now(),
      adapter: {
        ...deps().adapter,
        readCaptions: async () => {
          calls++;
          if (calls > 1) return [];
          // Wall-clock: t0 plus 500ms, exactly as google-meet.ts's own
          // readCaptions reports it (Date.now() at scrape time).
          return [{ speaker: "Priya", text: "the deadline slipped", atMs: t0 + 500 }];
        },
        hasEnded: async () => calls > 1
      },
      transcribe: async () => [
        {
          speaker: "participant" as const,
          text: "the deadline slipped",
          startMs: 500,
          isFinal: true
        }
      ]
    });
    const dir = await mkdtemp(join(tmpdir(), "ses-"));
    const promise = runBrowserMeeting(
      {
        url: "https://example.test/x",
        displayName: "Notetaker",
        chromeProfileDir: dir,
        recordsPath: join(dir, "r.jsonl"),
        transcriptsDir: dir,
        endedConfirmSeconds: SHORT_ENDED_CONFIRM_SECONDS
      },
      d
    );
    await vi.advanceTimersByTimeAsync(4000);
    const out = await promise;
    expect(out.transcriptPath).not.toBeNull();
    const lines = (await readFile(out.transcriptPath as string, "utf8")).trim().split("\n");
    const utterance = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(utterance.speakerId).toBe("Priya");
  });
});

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JOIN_OUTCOMES } from "@parley/core";
import type { TranscriptEvent } from "@parley/core";
import { startAudioTap } from "../src/audio-tap.js";
import { googleMeetAdapter } from "../src/google-meet.js";
import { isOperatorFacingError } from "../src/operator-error.js";
import type { PreflightDeps } from "../src/preflight.js";
import {
  DEFAULT_CDP_ENDPOINT,
  MEETING_EXIT_CAPTURE_FAULT,
  MEETING_EXIT_NEVER_JOINED,
  MEETING_EXIT_OK,
  MeetingConfigError,
  createMeetingSession,
  defaultChromeProfileDir,
  describeMeetingResult,
  meetingExitCode,
  resolveMeetingJoinConfig,
  runMeetingJoin,
  type CdpBrowser,
  type MeetingJoinConfig,
  type MeetingRuntimeDeps
} from "../src/run.js";
import type { BrowserMeetingResult } from "../src/session.js";
import { TranscriptionInterruptedError } from "../src/transcription-interrupted.js";
import { SIGTERM_HANDLING_CAPTURE, fakeFfmpeg } from "./fake-ffmpeg.js";

const JOIN = ["join", "https://meet.example.test/abc-defg-hij"] as const;

/** The minimum environment a join resolves from. Every test that is not about
 * a missing value starts here and removes exactly the one it is about, so a
 * failure names one cause rather than several. */
function env(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    HOME: "/home/operator",
    PARLEY_MEET_DISPLAY_NAME: "Notetaker (recording)",
    PARLEY_CALL_RECORDS_PATH: "/var/parley/records.jsonl",
    PARLEY_MEET_AUDIO_DEVICE: "Loopback Aggregate",
    DEEPGRAM_API_KEY: "dg-test-key",
    ...overrides
  };
}

const FIXED_RESOLVE = {
  now: () => Date.parse("2026-08-22T17:04:05.000Z"),
  runId: () => "a1b2c3d4"
};

function config(overrides: Partial<MeetingJoinConfig> = {}): MeetingJoinConfig {
  return {
    ...resolveMeetingJoinConfig([...JOIN], env(), FIXED_RESOLVE),
    ...overrides
  };
}

describe("resolveMeetingJoinConfig", () => {
  it("REFUSES to invent a display name — it is the only disclosure to the room", () => {
    // This transport speaks no announcement, so the name in the participant
    // list is the entire notice that a notetaker is present. A default here
    // would be this package deciding, on a deployment's behalf, what a room is
    // told about being recorded.
    const error = (() => {
      try {
        resolveMeetingJoinConfig([...JOIN], env({ PARLEY_MEET_DISPLAY_NAME: undefined }));
      } catch (e: unknown) {
        return e;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(MeetingConfigError);
    expect((error as Error).message).toContain("--display-name");
    expect((error as Error).message).toContain("PARLEY_MEET_DISPLAY_NAME");
    expect((error as Error).message).toContain("only disclosure");
  });

  it("requires a records path, and says why a failed join needs one", () => {
    expect(() =>
      resolveMeetingJoinConfig([...JOIN], env({ PARLEY_CALL_RECORDS_PATH: undefined }))
    ).toThrow(/--records-path[\s\S]*including a failed one/);
  });

  it("requires an audio device rather than guessing at one", () => {
    // A wrong guess captures the room the host machine is sitting in — audio
    // that is plausible, wrong, and indistinguishable after the fact.
    expect(() =>
      resolveMeetingJoinConfig([...JOIN], env({ PARLEY_MEET_AUDIO_DEVICE: undefined }))
    ).toThrow(/--audio-device[\s\S]*captures the room/);
  });

  it("refuses to run with no transcription key rather than recording silence", () => {
    expect(() => resolveMeetingJoinConfig([...JOIN], env({ DEEPGRAM_API_KEY: undefined }))).toThrow(
      /DEEPGRAM_API_KEY/
    );
  });

  it("never accepts the transcription key as a flag", () => {
    // argv is readable by every process on the host; the environment is not.
    const resolved = resolveMeetingJoinConfig(
      [...JOIN, "--deepgram-api-key", "leaked-on-the-command-line"],
      env(),
      FIXED_RESOLVE
    );
    expect(resolved.deepgramApiKey).toBe("dg-test-key");
  });

  it("takes a flag over the environment", () => {
    const resolved = resolveMeetingJoinConfig(
      [...JOIN, "--display-name", "From the flag", "--audio-device", "Other Device"],
      env(),
      FIXED_RESOLVE
    );
    expect(resolved.displayName).toBe("From the flag");
    expect(resolved.audioDevice).toBe("Other Device");
  });

  it("defaults the CDP endpoint and the profile dir to what the setup document fixes", () => {
    const resolved = resolveMeetingJoinConfig([...JOIN], env(), FIXED_RESOLVE);
    expect(resolved.cdpEndpoint).toBe(DEFAULT_CDP_ENDPOINT);
    expect(resolved.chromeProfileDir).toBe(defaultChromeProfileDir("/home/operator"));
  });

  it("gives each run its own transcripts directory", () => {
    // `writeTranscriptJsonl` always names the file `transcript.jsonl` inside
    // the directory it is given, so a directory shared between runs means the
    // second meeting silently destroys the first one's transcript.
    const a = resolveMeetingJoinConfig([...JOIN], env(), { ...FIXED_RESOLVE, runId: () => "aaa" });
    const b = resolveMeetingJoinConfig([...JOIN], env(), { ...FIXED_RESOLVE, runId: () => "bbb" });
    expect(a.transcriptsDir).not.toBe(b.transcriptsDir);
    expect(a.transcriptsDir).toBe("/var/parley/meetings/2026-08-22/aaa");
  });

  it("lets an operator name the transcripts directory outright", () => {
    expect(
      resolveMeetingJoinConfig([...JOIN, "--transcripts-dir", "/elsewhere"], env(), FIXED_RESOLVE)
        .transcriptsDir
    ).toBe("/elsewhere");
  });

  it("carries PARLEY_POST_CALL_COMMAND through, and leaves it undefined when unset", () => {
    expect(
      resolveMeetingJoinConfig([...JOIN], env({ PARLEY_POST_CALL_COMMAND: "/usr/local/bin/hook" }))
        .postCallCommand
    ).toBe("/usr/local/bin/hook");
    expect(resolveMeetingJoinConfig([...JOIN], env()).postCallCommand).toBeUndefined();
  });

  it("treats a flag with no value as a typo rather than a request for the default", () => {
    // Silently defaulting here is how a run joins the room under the wrong name.
    expect(() =>
      resolveMeetingJoinConfig([...JOIN, "--display-name", "--audio-device", "x"], env())
    ).toThrow(/--display-name needs a value/);
  });

  it("needs a meeting URL, and says so", () => {
    expect(() => resolveMeetingJoinConfig(["join"], env())).toThrow(/needs a meeting URL/);
  });

  it("refuses an unknown subcommand instead of joining something", () => {
    expect(() => resolveMeetingJoinConfig(["leave"], env())).toThrow(/Unknown meeting subcommand/);
  });

  it("rejects a --max-seconds that is not a positive number", () => {
    expect(() => resolveMeetingJoinConfig([...JOIN, "--max-seconds", "soon"], env())).toThrow(
      /--max-seconds must be a positive number/
    );
    expect(
      resolveMeetingJoinConfig([...JOIN, "--max-seconds", "600"], env(), FIXED_RESOLVE)
        .maxMeetingSeconds
    ).toBe(600);
  });

  /** The tolerance a deployment can raise on a flaky link: how long the
   * meeting UI has to look gone before this run believes the meeting ended.
   * Left unset it is `HAS_ENDED_CONFIRM_MS`, and the session must not carry a
   * default of its own — two places for one number is how the shipped value
   * and the documented value part company. */
  it("takes an ended-confirmation tolerance from a flag or the environment, and leaves it unset otherwise", () => {
    expect(resolveMeetingJoinConfig([...JOIN], env(), FIXED_RESOLVE).endedConfirmSeconds).toBe(
      undefined
    );
    expect(
      resolveMeetingJoinConfig([...JOIN, "--ended-confirm-seconds", "45"], env(), FIXED_RESOLVE)
        .endedConfirmSeconds
    ).toBe(45);
    expect(
      resolveMeetingJoinConfig(
        [...JOIN],
        env({ PARLEY_MEET_ENDED_CONFIRM_SECONDS: "45" }),
        FIXED_RESOLVE
      ).endedConfirmSeconds
    ).toBe(45);
    // A tolerance of zero or a typo is not a request for the default: it is a
    // window that can never be met, or one that ends the meeting on the first
    // blink.
    for (const bad of ["0", "-5", "soon"]) {
      expect(() =>
        resolveMeetingJoinConfig([...JOIN, "--ended-confirm-seconds", bad], env())
      ).toThrow(/--ended-confirm-seconds must be a positive number/);
    }
  });

  it("marks every configuration failure as operator-facing", () => {
    // The CLI prints `message` alone for these; a stack trace at the moment a
    // meeting is starting is a failed meeting.
    try {
      resolveMeetingJoinConfig([...JOIN], env({ PARLEY_MEET_DISPLAY_NAME: undefined }));
      expect.unreachable();
    } catch (error) {
      expect(isOperatorFacingError(error)).toBe(true);
    }
  });
});

/** The smallest page `googleMeetAdapter.join` can actually drive: every
 * selector matches nothing, and the page's text is a state `classifyPreJoin`
 * recognises. That combination reaches a terminal outcome on the first poll,
 * so a whole meeting runs here without a browser, a fixture or a clock.
 *
 * A page stand-in rather than an opaque object because the real adapter IS
 * wired in — an opaque marker is rejected by `google-meet.ts`'s own page
 * guard, which is the composition working as intended. */
function fakePage(bodyText: string): Record<string, unknown> & { closed: boolean } {
  const nothing = {
    count: async () => 0,
    click: async () => {},
    fill: async () => {},
    getAttribute: async () => null,
    first: () => nothing
  };
  const page = {
    marker: "the-attached-page",
    // A real Playwright Page has this and the teardown calls it. A stand-in
    // without one would make every test here take the "cannot be closed"
    // branch, which is the failure path rather than the shipped one.
    closed: false,
    close: async (): Promise<void> => {
      page.closed = true;
    },
    goto: async () => undefined,
    innerText: async () => bodyText,
    locator: () => nothing,
    waitForTimeout: async () => {},
    evaluate: async () => ({
      regionPresent: false,
      lines: [],
      avatarCount: 0,
      visibleTextLength: 0
    })
  };
  return page;
}

/** A CDP browser that records what was asked of it and hands back a page. No
 * Playwright, no Chrome — what is under test is which implementation reaches
 * which dependency slot. */
function fakeBrowser(
  bodyText = "Someone in the meeting denied your request to join"
): CdpBrowser & { newPageCalls: number; closed: boolean; page: { closed: boolean } } {
  const page = fakePage(bodyText);
  const browser = {
    newPageCalls: 0,
    closed: false,
    page,
    contexts: () => [
      {
        newPage: async (): Promise<unknown> => {
          browser.newPageCalls += 1;
          return page;
        }
      }
    ],
    close: async (): Promise<void> => {
      browser.closed = true;
    }
  };
  return browser;
}

function runtime(overrides: Partial<MeetingRuntimeDeps> = {}): MeetingRuntimeDeps {
  return {
    connectOverCdp: vi.fn(async () => fakeBrowser()),
    connectTranscription: vi.fn(async () => ({
      sendAudio: () => {},
      flush: async () => {},
      close: async () => {}
    })),
    startTap: vi.fn(() => ({ frames: (async function* () {})(), stop: async () => {} })),
    dispatch: vi.fn(async () => 0),
    clock: () => 1_755_000_000_000,
    ...overrides
  };
}

describe("createMeetingSession — the composition", () => {
  it("wires the Google Meet adapter into the adapter slot", () => {
    expect(createMeetingSession(config(), runtime()).deps.adapter).toBe(googleMeetAdapter);
  });

  it("ATTACHES over CDP and never launches a browser", async () => {
    // A browser Playwright launches carries automation markers and Google
    // refuses sign-in to it (docs/profile-setup.md). There is no launcher in
    // this package at all — the assertion is that the only door out is the CDP
    // connector, called with the configured endpoint.
    const browser = fakeBrowser();
    const deps = runtime({ connectOverCdp: vi.fn(async () => browser) });
    const session = createMeetingSession(config({ cdpEndpoint: "http://127.0.0.1:9444" }), deps);

    const page = await session.deps.openPage("/ignored");

    expect(deps.connectOverCdp).toHaveBeenCalledWith("http://127.0.0.1:9444");
    // The page came from the operator's EXISTING context, not from
    // `browser.newPage()`, which on a CDP connection makes a fresh context
    // carrying none of the signed-in session.
    expect(browser.newPageCalls).toBe(1);
    expect(page).toBe(browser.page);
  });

  it("closes the page it opened, and nothing else of the operator's", async () => {
    // This transport attaches to a Chrome a human started and signed into by
    // hand. The one tab it opened itself is the only thing it may close: the
    // context IS that signed-in profile and holds whatever else they had
    // open, and `browser.close()` is a different operation entirely (it
    // merely disconnects, and belongs to MeetingSession.close).
    const browser = fakeBrowser();
    const session = createMeetingSession(
      config(),
      runtime({ connectOverCdp: async () => browser })
    );

    const page = await session.deps.openPage("/ignored");
    await session.deps.closePage(page);

    expect(browser.page.closed).toBe(true);
    expect(browser.closed).toBe(false);
  });

  it("reports a page it cannot close rather than leaving a notetaker in the meeting silently", async () => {
    // Guarded by session.ts, so this throw becomes a captureFault on a record
    // that still gets written — but it must be a throw, because a page that
    // cannot be closed is exactly the failure the teardown exists to prevent.
    const session = createMeetingSession(config(), runtime());
    await expect(session.deps.closePage({ marker: "not a page" })).rejects.toThrow(
      /no close\(\) method/
    );
  });

  it("says what to do when the attached Chrome has no context to open a page in", async () => {
    const session = createMeetingSession(
      config(),
      runtime({
        connectOverCdp: async () => ({ contexts: () => [], close: async () => {} })
      })
    );
    await expect(session.deps.openPage("/ignored")).rejects.toThrow(/profile-setup\.md/);
  });

  it("disconnects from the operator's Chrome on close, and is safe when nothing connected", async () => {
    const browser = fakeBrowser();
    const session = createMeetingSession(
      config(),
      runtime({ connectOverCdp: async () => browser })
    );
    await session.close();
    expect(browser.closed).toBe(false);

    await session.deps.openPage("/ignored");
    await session.close();
    expect(browser.closed).toBe(true);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("starts the tap on the configured device, with the configured capture binary", () => {
    const deps = runtime();
    const session = createMeetingSession(
      config({ audioDevice: "Loopback Aggregate", ffmpegPath: "/somewhere/ffmpeg" }),
      deps
    );
    session.deps.startTap();
    expect(deps.startTap).toHaveBeenCalledWith("Loopback Aggregate", "/somewhere/ffmpeg");
  });

  it("binds the post-call dispatcher to PARLEY_POST_CALL_COMMAND at construction", async () => {
    // `session.ts` must never read the environment itself — that separation is
    // what lets its own tests inject a fake dispatcher rather than mutate the
    // process. The binding happens here, once, at construction.
    const deps = runtime();
    const session = createMeetingSession(config({ postCallCommand: "/usr/local/bin/hook" }), deps);

    await session.deps.dispatchPostCall("/var/parley/records.jsonl", "MTG-1");

    expect(deps.dispatch).toHaveBeenCalledWith({
      command: "/usr/local/bin/hook",
      recordsPath: "/var/parley/records.jsonl",
      meetingId: "MTG-1"
    });
  });

  it("passes an undefined command through when no hook is configured", async () => {
    const deps = runtime();
    const session = createMeetingSession(config({ postCallCommand: undefined }), deps);
    await session.deps.dispatchPostCall("/r.jsonl", "MTG-2");
    expect(deps.dispatch).toHaveBeenCalledWith({
      command: undefined,
      recordsPath: "/r.jsonl",
      meetingId: "MTG-2"
    });
  });

  it("feeds every captured frame to the transcription plane and returns what it heard", async () => {
    const sent: Buffer[] = [];
    const heard: TranscriptEvent = {
      speaker: "participant",
      segmentId: "0",
      startMs: 0,
      endMs: 500,
      text: "morning",
      isFinal: true
    };
    let flushed = false;
    let closed = false;
    const session = createMeetingSession(
      config(),
      runtime({
        connectTranscription: async (_offsetMs, callbacks) => {
          callbacks.onTranscript(heard);
          return {
            sendAudio: (f: Buffer) => sent.push(f),
            flush: async () => {
              flushed = true;
            },
            close: async () => {
              closed = true;
            }
          };
        }
      })
    );

    const frames = (async function* () {
      yield Buffer.from([1, 2]);
      yield Buffer.from([3, 4]);
    })();

    // The order `session.ts` uses, and now the order this composition
    // requires: the session's clock, then the tap, then transcription. The
    // transcriber's time base is the difference between the first two, and
    // there is no honest value for it before both have happened.
    session.deps.now();
    session.deps.startTap();
    expect(await session.deps.transcribe(frames)).toEqual([heard]);
    expect(sent).toHaveLength(2);
    // Flushed before closing: Deepgram's last utterance is only promoted by
    // the flush, and closing first drops it.
    expect(flushed).toBe(true);
    expect(closed).toBe(true);
  });

  /** Two facts have to survive a tap that dies mid-meeting, and this used to
   * keep only the first: the pipeline is gone, AND the utterances already
   * delivered are real. The rejection still ends the meeting; what changed is
   * that it carries what was heard, so a tap death at minute 55 of 60 no
   * longer throws away all 55 minutes. */
  it("carries the utterances it already heard out of a tap that dies mid-meeting", async () => {
    const heard: TranscriptEvent = {
      speaker: "participant",
      segmentId: "0",
      startMs: 0,
      endMs: 500,
      text: "the deadline slipped",
      isFinal: true
    };
    let closed = false;
    let flushes = 0;
    const session = createMeetingSession(
      config(),
      runtime({
        connectTranscription: async (_offsetMs, callbacks) => {
          callbacks.onTranscript(heard);
          return {
            sendAudio: () => {},
            flush: async () => {
              flushes += 1;
            },
            close: async () => {
              closed = true;
            }
          };
        }
      })
    );
    const frames = (async function* () {
      yield Buffer.from([1]);
      throw new Error("audio tap lost the stream");
    })();

    session.deps.now();
    session.deps.startTap();

    // Still a rejection — `session.ts` reads that as `transcription_lost` and
    // ends the meeting deliberately rather than sit on a call it is no longer
    // taking notes on. Resolving with the partial events would keep the words
    // and lose the fact that they stop early.
    const rejection = await session.deps.transcribe(frames).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(TranscriptionInterruptedError);
    expect((rejection as TranscriptionInterruptedError).events).toEqual([heard]);
    expect((rejection as Error).message).toContain("lost the stream");
    // What broke is the frame source, not the socket, so the last utterance
    // is still worth asking for before giving up on it.
    expect(flushes).toBe(1);
    expect(closed).toBe(true);
  });

  /** The end of every normal meeting, through the composition, against a real
   * child process that behaves like the capture binary — it handles SIGTERM
   * and exits 255. This is the discriminating test for the tap's stop
   * handling: with the tap treating that exit as a failure, `transcribe`
   * REJECTS here, the flush never runs, and the meeting's last utterance is
   * lost even though nothing anywhere reports a problem. */
  it("resolves and flushes when the tap is stopped mid-stream, rather than failing the meeting", async () => {
    const heard: TranscriptEvent = {
      speaker: "participant",
      segmentId: "0",
      startMs: 0,
      endMs: 500,
      text: "the deadline slipped",
      isFinal: true
    };
    let flushes = 0;
    let framesSent = 0;
    const tap = startAudioTap({
      device: "TestDevice",
      ffmpegPath: await fakeFfmpeg(SIGTERM_HANDLING_CAPTURE)
    });
    const session = createMeetingSession(
      config(),
      runtime({
        startTap: () => tap,
        connectTranscription: async (_offsetMs, callbacks) => {
          callbacks.onTranscript(heard);
          return {
            sendAudio: () => {
              framesSent += 1;
            },
            flush: async () => {
              flushes += 1;
            },
            close: async () => {}
          };
        }
      })
    );

    session.deps.now();
    const started = session.deps.startTap();
    const transcribed = session.deps.transcribe(started.frames);
    // Waits for a frame rather than for a duration. A fixed sleep races the
    // child's own start-up — which for a Node stand-in is tens of
    // milliseconds — and a stop that lands first tests nothing: it kills a
    // process that has not begun capturing, which is not the case under test.
    await vi.waitFor(() => {
      expect(framesSent).toBeGreaterThan(0);
    });
    await started.stop();

    await expect(transcribed).resolves.toEqual([heard]);
    // Deepgram promotes its last buffered utterance only on the flush, so a
    // stop that skipped it would silently drop the final thing said.
    expect(flushes).toBe(1);
  });

  /** Every branch of the old expression produced a NUMBER, and each number
   * was silently catastrophic: a missing session clock gave an epoch-scale
   * offset, a missing tap instant gave 0, and either way every cue misses
   * `attributeEvents`' three-second window, all attribution disappears from
   * the transcript, and nothing errors. A throw is the only honest output —
   * `session.ts` reads it as `transcription_lost` and writes a record
   * saying so. */
  it("refuses to guess a time base when it does not know when the tap started", async () => {
    const connectTranscription = vi.fn(async () => ({
      sendAudio: () => {},
      flush: async () => {},
      close: async () => {}
    }));
    const session = createMeetingSession(config(), runtime({ connectTranscription }));
    session.deps.now();

    await expect(session.deps.transcribe((async function* () {})())).rejects.toThrow(
      /audio tap has not been started/
    );
    // And no socket was opened for a meeting whose transcript could not have
    // been attributed anyway.
    expect(connectTranscription).not.toHaveBeenCalled();
  });

  it("refuses to guess a time base when the session's own clock has not been read", async () => {
    const session = createMeetingSession(config(), runtime());
    await expect(session.deps.transcribe((async function* () {})())).rejects.toThrow(
      /session's clock has not been read/
    );
  });

  /** Impossible on a monotonic clock read in this order, so reaching it means
   * the host stepped its clock mid-join. `Math.max(0, …)` used to absorb it,
   * which discards the whole join duration and unattributes the meeting. */
  it("refuses a time base built from a clock that moved backwards", async () => {
    let clock = 50_000;
    const session = createMeetingSession(config(), runtime({ clock: () => clock }));
    session.deps.now();
    clock = 10_000;
    session.deps.startTap();

    await expect(session.deps.transcribe((async function* () {})())).rejects.toThrow(
      /clock moved backwards/
    );
  });

  it("offsets the transcript's clock by how long the join took", async () => {
    // The session's time base is t0 (its first `now()`); the transcription
    // plane's starts at zero when the tap opens, which is AFTER the join and
    // the captions toggle. Left at zero the two bases differ by the whole join
    // duration, `attributeEvents`' three-second window never matches, and
    // every utterance comes back unattributed while both halves look healthy.
    let clock = 1_000_000;
    let offset: number | undefined;
    const session = createMeetingSession(
      config(),
      runtime({
        clock: () => clock,
        connectTranscription: async (offsetMs) => {
          offset = offsetMs;
          return { sendAudio: () => {}, flush: async () => {}, close: async () => {} };
        }
      })
    );

    session.deps.now(); // runBrowserMeeting's first statement: `const t0 = deps.now()`
    clock += 42_000; // a waiting room
    session.deps.startTap();
    await session.deps.transcribe((async function* () {})());

    expect(offset).toBe(42_000);
  });
});

describe("runMeetingJoin", () => {
  function preflight(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
    return {
      probeCdpEndpoint: vi.fn(async () => {}),
      listAudioInputDevices: vi.fn(async () => ["Loopback Aggregate"]),
      probeWritable: vi.fn(async () => {}),
      ...overrides
    };
  }

  it("runs a whole meeting with no browser, no device and no network, and writes a record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-"));
    const recordsPath = join(dir, "records.jsonl");
    const browser = fakeBrowser();

    const result = await runMeetingJoin(
      [
        ...JOIN,
        "--records-path",
        recordsPath,
        "--transcripts-dir",
        join(dir, "t"),
        "--display-name",
        "Notetaker (recording)"
      ],
      env(),
      {
        preflight: preflight(),
        runtime: runtime({ connectOverCdp: async () => browser })
      }
    );

    expect(result.joinOutcome).toBe("denied");
    const record = JSON.parse((await readFile(recordsPath, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    expect(record.transport).toBe("browser");
    // Even an attempt that never became a meeting leaves evidence — a consumer
    // watches records, so a silent attempt would be invisible rather than
    // failed.
    expect(record.status).toBe("never_joined");
    expect(record.joinOutcome).toBe("denied");
    // And the CDP connection is dropped, or the process never exits.
    expect(browser.closed).toBe(true);
    // The tab this run opened is closed too — end to end, through the real
    // composition. Left open, the notetaker stays in the participant list
    // after the process that owned it is gone.
    expect(browser.page.closed).toBe(true);
  });

  it("checks every prerequisite BEFORE opening a browser or a capture device", async () => {
    const deps = runtime();
    await expect(
      runMeetingJoin([...JOIN], env(), {
        preflight: preflight({
          probeCdpEndpoint: async () => {
            throw new Error("ECONNREFUSED");
          }
        }),
        runtime: deps
      })
    ).rejects.toThrow(/prerequisite\(s\) are not met/);

    expect(deps.connectOverCdp).not.toHaveBeenCalled();
    expect(deps.startTap).not.toHaveBeenCalled();
  });

  it("fails on configuration before it probes anything at all", async () => {
    const checks = preflight();
    await expect(
      runMeetingJoin([...JOIN], env({ PARLEY_MEET_DISPLAY_NAME: undefined }), {
        preflight: checks,
        runtime: runtime()
      })
    ).rejects.toThrow(/--display-name/);
    expect(checks.probeCdpEndpoint).not.toHaveBeenCalled();
  });
});

describe("meetingExitCode", () => {
  function result(overrides: Partial<BrowserMeetingResult> = {}): BrowserMeetingResult {
    return {
      joinOutcome: "admitted",
      recordsPath: "/var/parley/records.jsonl",
      transcriptPath: "/var/parley/meetings/t/transcript.jsonl",
      captionsEnabled: true,
      captureFault: null,
      ...overrides
    };
  }

  it("exits 0 only on a meeting that was joined and went cleanly", () => {
    expect(meetingExitCode(result())).toBe(MEETING_EXIT_OK);
    // Captions off is NOT a failure — the transcript is unattributed, not
    // missing, and a wrapper must not be paged for it.
    expect(meetingExitCode(result({ captionsEnabled: false }))).toBe(MEETING_EXIT_OK);
  });

  /** Every one of these exited 0. For a scheduled notetaker the exit code is
   * the only signal a wrapper reads, and this repository's own history has a
   * hook that failed for weeks because nobody observed one.
   *
   * Driven off `JOIN_OUTCOMES` minus `"admitted"` rather than off a hand-kept
   * list: an outcome added to core and forgotten here would be an outcome
   * this contract has never been checked against, and the exit code is the
   * whole contract with whatever runs `parley` on a schedule. */
  it.each(JOIN_OUTCOMES.filter((outcome) => outcome !== "admitted"))(
    "exits nonzero on a join that ended %s",
    (joinOutcome) => {
      expect(meetingExitCode(result({ joinOutcome, transcriptPath: null }))).toBe(
        MEETING_EXIT_NEVER_JOINED
      );
    }
  );

  it("exits with a DIFFERENT code when the meeting happened but something broke", () => {
    // A wrapper's response differs: nobody was in the meeting, versus the
    // artifacts exist and are incomplete.
    expect(meetingExitCode(result({ captureFault: new Error("captions region gone") }))).toBe(
      MEETING_EXIT_CAPTURE_FAULT
    );
    expect(MEETING_EXIT_CAPTURE_FAULT).not.toBe(MEETING_EXIT_NEVER_JOINED);
    // And 1 is left alone: it is what the CLI's top-level catch sets for an
    // exception, which is a different event from a meeting that ran badly.
    expect([MEETING_EXIT_NEVER_JOINED, MEETING_EXIT_CAPTURE_FAULT]).not.toContain(1);
  });

  it("reports the failed join even when something also broke", () => {
    // A run that never got in is a bigger fact than anything that broke while
    // it was not there.
    expect(
      meetingExitCode(result({ joinOutcome: "denied", captureFault: new Error("also this") }))
    ).toBe(MEETING_EXIT_NEVER_JOINED);
  });
});

describe("describeMeetingResult", () => {
  it("reports an unattributed transcript as a fact, not as a failure", () => {
    const out = describeMeetingResult({
      joinOutcome: "admitted",
      recordsPath: "/r.jsonl",
      transcriptPath: "/t/transcript.jsonl",
      captionsEnabled: false,
      captureFault: null
    });
    expect(out).toContain("attribution is missing or incomplete");
    expect(out).not.toContain("capture fault");
  });

  it("names a capture fault on a run that still produced its artifacts", () => {
    const out = describeMeetingResult({
      joinOutcome: "admitted",
      recordsPath: "/r.jsonl",
      transcriptPath: "/t/transcript.jsonl",
      captionsEnabled: true,
      captureFault: new Error("captions region not found")
    });
    expect(out).toContain("capture fault:  captions region not found");
  });

  it("says plainly that a join that was never admitted has no transcript", () => {
    const out = describeMeetingResult({
      joinOutcome: "denied",
      recordsPath: "/r.jsonl",
      transcriptPath: null,
      captionsEnabled: false,
      captureFault: null
    });
    expect(out).toContain("never admitted");
  });
});

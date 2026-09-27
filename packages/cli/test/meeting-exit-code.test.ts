import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEETING_EXIT_NEVER_JOINED, type MeetingJoinDeps } from "@parley/meeting-browser";
import { main } from "../src/cli.js";

/** `parley meeting join` printed its summary and exited 0 on every run that
 * produced a result — a denied join, an expired session, a waiting-room
 * timeout and a non-null capture fault alike. For a scheduled notetaker the
 * exit code is the only signal a wrapper reads, and this repository's own
 * history has a delivery hook that failed for weeks because nobody observed
 * one.
 *
 * `meetingExitCode`'s own rules are pinned in @parley/meeting-browser. What
 * is pinned HERE is the wire: that the meeting's outcome reaches
 * `process.exitCode` at all. An untested wire between two tested halves is
 * exactly how the first one went unnoticed. */

/** The smallest page `googleMeetAdapter.join` can drive: every selector
 * matches nothing and the page text is a state `classifyPreJoin` recognises,
 * so a whole meeting runs here with no browser, no device and no network. */
function fakePage(bodyText: string): Record<string, unknown> {
  const nothing = {
    count: async () => 0,
    click: async () => {},
    fill: async () => {},
    getAttribute: async () => null,
    first: () => nothing
  };
  return {
    goto: async () => undefined,
    close: async () => undefined,
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
}

function meetingDeps(bodyText: string): MeetingJoinDeps {
  return {
    preflight: {
      probeCdpEndpoint: async () => {},
      listAudioInputDevices: async () => ["Loopback Aggregate"],
      probeWritable: async () => {}
    },
    runtime: {
      connectOverCdp: async () => ({
        contexts: () => [{ newPage: async () => fakePage(bodyText) }],
        close: async () => {}
      }),
      connectTranscription: async () => ({
        sendAudio: () => {},
        flush: async () => {},
        close: async () => {}
      }),
      startTap: () => ({ frames: (async function* () {})(), stop: async () => {} }),
      dispatch: async () => 0,
      clock: Date.now
    }
  };
}

const ENV_KEYS = [
  "PARLEY_MEET_DISPLAY_NAME",
  "PARLEY_CALL_RECORDS_PATH",
  "PARLEY_MEET_AUDIO_DEVICE",
  "DEEPGRAM_API_KEY",
  "PARLEY_MEET_TRANSCRIPTS_DIR"
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("parley meeting join, as a scheduled wrapper sees it", () => {
  async function run(bodyText: string): Promise<number | string | undefined | null> {
    const dir = await mkdtemp(join(tmpdir(), "cli-meeting-"));
    const values: Record<(typeof ENV_KEYS)[number], string> = {
      PARLEY_MEET_DISPLAY_NAME: "Notetaker (recording)",
      PARLEY_CALL_RECORDS_PATH: join(dir, "records.jsonl"),
      PARLEY_MEET_AUDIO_DEVICE: "Loopback Aggregate",
      DEEPGRAM_API_KEY: "dg-test-key",
      PARLEY_MEET_TRANSCRIPTS_DIR: join(dir, "t")
    };
    for (const key of ENV_KEYS) vi.stubEnv(key, values[key]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["meeting", "join", "https://meet.example.test/abc-defg-hij"], {
        meeting: meetingDeps(bodyText)
      });
    } finally {
      log.mockRestore();
    }
    return process.exitCode;
  }

  // The exact code, not merely "not zero": an unset `process.exitCode` is
  // `undefined`, which is not zero either, so a "not 0" assertion passes on a
  // build where nothing sets it at all — which is the defect.
  it("exits never-joined when the join was refused at the door", async () => {
    expect(await run("Someone in the meeting denied your request to join")).toBe(
      MEETING_EXIT_NEVER_JOINED
    );
  });

  it("exits never-joined when the meeting had not started", async () => {
    expect(await run("This meeting hasn't started yet")).toBe(MEETING_EXIT_NEVER_JOINED);
  });

  it("exits never-joined when the session needs signing in again", async () => {
    expect(await run("Sign in to join this meeting")).toBe(MEETING_EXIT_NEVER_JOINED);
  });
});

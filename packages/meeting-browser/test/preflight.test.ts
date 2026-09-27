import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MeetingPreflightError,
  chromeLaunchHint,
  parseAvfoundationAudioDevices,
  preflightMeeting,
  realPreflightDeps,
  type PreflightDeps,
  type PreflightSubject
} from "../src/preflight.js";

/** The shape ffmpeg's avfoundation input device actually prints — both
 * sections, the log prefix, and the trailing blank line. Captured from real
 * output rather than invented, because the parser's whole job is to survive
 * this exact format. */
const FFMPEG_DEVICE_LIST = [
  "[AVFoundation indev @ 0x7f8b1] AVFoundation video devices:",
  "[AVFoundation indev @ 0x7f8b1] [0] Built-in Camera",
  "[AVFoundation indev @ 0x7f8b1] [1] Capture screen 0",
  "[AVFoundation indev @ 0x7f8b1] AVFoundation audio devices:",
  "[AVFoundation indev @ 0x7f8b1] [0] Loopback Aggregate",
  "[AVFoundation indev @ 0x7f8b1] [1] Built-in Microphone",
  ": Input/output error",
  ""
].join("\n");

function subject(overrides: Partial<PreflightSubject> = {}): PreflightSubject {
  return {
    cdpEndpoint: "http://127.0.0.1:9222",
    chromeProfileDir: "/tmp/meet-profile",
    audioDevice: "Loopback Aggregate",
    ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    recordsPath: "/tmp/records/meetings.jsonl",
    transcriptsDir: "/tmp/records/meetings/run",
    ...overrides
  };
}

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    probeCdpEndpoint: vi.fn(async () => {}),
    listAudioInputDevices: vi.fn(async () => ["Loopback Aggregate", "Built-in Microphone"]),
    probeWritable: vi.fn(async () => {}),
    ...overrides
  };
}

describe("parseAvfoundationAudioDevices", () => {
  it("reads the audio section, in the index order avfoundation assigned", () => {
    expect(parseAvfoundationAudioDevices(FFMPEG_DEVICE_LIST)).toEqual([
      "Loopback Aggregate",
      "Built-in Microphone"
    ]);
  });

  it("does NOT read cameras as capturable audio devices", () => {
    // Both sections print `[N] Name`, so a parser that just matched that shape
    // would let a typo'd device name "match" a camera and send the capture at
    // something that produces no audio at all.
    const devices = parseAvfoundationAudioDevices(FFMPEG_DEVICE_LIST);
    expect(devices).not.toContain("Built-in Camera");
    expect(devices).not.toContain("Capture screen 0");
  });

  it("returns nothing rather than throwing when the output holds no device list", () => {
    expect(parseAvfoundationAudioDevices("ffmpeg version 7.1\n")).toEqual([]);
  });
});

describe("preflightMeeting", () => {
  it("resolves when every prerequisite is met", async () => {
    await expect(preflightMeeting(subject(), deps())).resolves.toBeUndefined();
  });

  it("names the endpoint AND the command that starts Chrome when nothing answers", async () => {
    const error = await preflightMeeting(
      subject({ cdpEndpoint: "http://127.0.0.1:9333", chromeProfileDir: "/tmp/a-profile" }),
      deps({
        probeCdpEndpoint: async () => {
          throw new Error("fetch failed: ECONNREFUSED");
        }
      })
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MeetingPreflightError);
    const message = (error as Error).message;
    expect(message).toContain("http://127.0.0.1:9333");
    // The remedy, not just the symptom.
    expect(message).toContain("--remote-debugging-port=9333");
    expect(message).toContain("--user-data-dir=");
    expect(message).toContain("/tmp/a-profile");
    // And the reason there is no "just launch it for me" option.
    expect(message).toContain("never launches");
  });

  it("lists the devices that ARE present when the configured one is not", async () => {
    const error = await preflightMeeting(
      subject({ audioDevice: "Loopback Aggregat" }),
      deps()
    ).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('"Loopback Aggregat"');
    expect(message).toContain("[0] Loopback Aggregate");
    expect(message).toContain("[1] Built-in Microphone");
    expect(message).toContain("PARLEY_MEET_AUDIO_DEVICE");
  });

  it("accepts a device index, and rejects one past the end of the list", async () => {
    // `-i ":<n>"` is avfoundation's own syntax and ffmpeg's list leads with the
    // index, so an operator naming one is not making a mistake.
    await expect(preflightMeeting(subject({ audioDevice: "1" }), deps())).resolves.toBeUndefined();
    await expect(preflightMeeting(subject({ audioDevice: "7" }), deps())).rejects.toThrow(
      /No audio input device named "7"/
    );
  });

  it("distinguishes an EMPTY device list from a device that is merely absent", async () => {
    // "Set --audio-device to one of those names" points at nothing when the
    // list is empty, and an empty list is not exotic: macOS withholds every
    // audio input from a process without microphone access, and reports the
    // absence as an empty list rather than as a denial.
    const error = await preflightMeeting(
      subject(),
      deps({ listAudioInputDevices: async () => [] })
    ).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain("NO audio input devices at all");
    expect(message).toContain("Microphone");
    expect(message).not.toContain("No audio input device named");
  });

  it("says to install ffmpeg when the capture binary cannot be run at all", async () => {
    // Distinct from "that device is not present": collapsing the two would
    // send an operator to check their audio routing when the answer is that
    // there is no ffmpeg on this host.
    const error = await preflightMeeting(
      subject({ ffmpegPath: "/nope/ffmpeg" }),
      deps({
        listAudioInputDevices: async () => {
          throw new Error("could not run /nope/ffmpeg: ENOENT");
        }
      })
    ).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain("/nope/ffmpeg");
    expect(message).toContain("Install ffmpeg");
    expect(message).not.toContain("No audio input device named");
  });

  it("says where the records file goes, and why it matters, when it cannot be written", async () => {
    const error = await preflightMeeting(
      subject({ recordsPath: "/read-only/records.jsonl" }),
      deps({
        probeWritable: async (path: string) => {
          if (path.startsWith("/read-only")) throw new Error("EACCES: permission denied");
        }
      })
    ).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain("/read-only/records.jsonl");
    expect(message).toContain("PARLEY_CALL_RECORDS_PATH");
    // A failed join still appends a record; that is why an unwritable path is
    // fatal rather than cosmetic.
    expect(message).toContain("including a failed one");
  });

  it("reports EVERY unmet prerequisite at once, not just the first", async () => {
    // An operator setting this up for the first time usually has more than one
    // thing wrong. Failing on the first would cost them one meeting per fix.
    const error = await preflightMeeting(
      subject({ audioDevice: "Nothing" }),
      deps({
        probeCdpEndpoint: async () => {
          throw new Error("ECONNREFUSED");
        },
        probeWritable: async (path: string) => {
          if (path.includes("/tmp/records")) throw new Error("EACCES");
        }
      })
    ).catch((e: unknown) => e);

    // Four: the records directory, the transcripts directory beneath it, the
    // device, and the endpoint.
    expect((error as MeetingPreflightError).problems).toHaveLength(4);
    expect((error as Error).message).toContain("4 prerequisite(s) are not met");
  });

  it("carries the operator-facing marker, so a caller prints the message and not a stack", () => {
    expect(new MeetingPreflightError(["x"]).operatorFacing).toBe(true);
  });
});

describe("chromeLaunchHint", () => {
  it("quotes the port the operator actually configured, never a guessed one", () => {
    // Printing 9222 at someone running on 9444 sends them to a window this run
    // will not attach to.
    expect(chromeLaunchHint("/tmp/p", "http://127.0.0.1:9444")).toContain(
      "--remote-debugging-port=9444"
    );
  });

  it("falls back to the endpoint verbatim rather than inventing a port", () => {
    expect(chromeLaunchHint("/tmp/p", "not-a-url")).toContain("--remote-debugging-port=not-a-url");
  });
});

describe("realPreflightDeps().probeWritable", () => {
  it("accepts a path whose nearest EXISTING ancestor is writable", async () => {
    // Neither the records directory nor the per-run transcripts directory
    // exists on a first run, so asking whether the leaf is writable would fail
    // every healthy deployment. Nothing is created: preflight observes.
    const base = await mkdtemp(join(tmpdir(), "pf-"));
    const leaf = join(base, "meetings", "2026-08-22", "a1b2c3d4");
    await expect(realPreflightDeps().probeWritable(leaf)).resolves.toBeUndefined();
    await expect(stat(join(base, "meetings"))).rejects.toThrow();
  });

  it("rejects when the nearest existing ancestor refuses the write", async () => {
    // Climbing PAST a directory that exists and refuses us would find a
    // writable ancestor and report success — the one wrong answer this walk
    // can give.
    const base = await mkdtemp(join(tmpdir(), "pf-"));
    const locked = join(base, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      await expect(
        realPreflightDeps().probeWritable(join(locked, "deep", "deeper"))
      ).rejects.toThrow();
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("preflightMeeting artifact locations", () => {
  it("checks the transcripts directory too, not only the records path", async () => {
    // `emitMeetingArtifacts` writes the transcript BEFORE it appends the
    // record, so a transcripts directory that refuses the write costs the
    // meeting both artifacts — and --transcripts-dir is independently
    // configurable, so the records path passing says nothing about it.
    const error = await preflightMeeting(
      subject({ transcriptsDir: "/read-only/meetings/run" }),
      deps({
        probeWritable: async (path: string) => {
          if (path.startsWith("/read-only")) throw new Error("EACCES: permission denied");
        }
      })
    ).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain("/read-only/meetings/run");
    expect(message).toContain("PARLEY_MEET_TRANSCRIPTS_DIR");
    expect(message).toContain("before the record is appended");
  });
});

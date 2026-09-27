import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { OperatorFacingError } from "./operator-error.js";

/** How long to wait for the CDP endpoint's HTTP handshake before calling it
 * unreachable. Generous for a loopback request that either answers instantly
 * or is answered by nothing at all, and short enough that an operator whose
 * Chrome is not running finds out now rather than after the meeting has
 * started without them. */
export const CDP_PROBE_TIMEOUT_MS = 3000;

/** How long to wait for the capture binary to finish listing devices. It
 * prints its list and exits immediately; anything longer than this is a
 * binary that is not going to answer. */
export const DEVICE_LIST_TIMEOUT_MS = 10_000;

/** The exact command `docs/profile-setup.md` tells an operator to run. Quoted
 * back at them in every attach failure, because "could not connect" without
 * the remedy is the failure this whole file exists to prevent: the endpoint
 * is unreachable precisely when the operator has not yet run this, or has
 * closed the window since. */
export function chromeLaunchHint(profileDir: string, endpoint: string): string {
  const port = cdpPort(endpoint);
  return (
    `Start it by hand (this transport ATTACHES to Chrome and never launches one — see\n` +
    `packages/meeting-browser/docs/profile-setup.md for why that distinction is load-bearing):\n\n` +
    `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n` +
    `    --user-data-dir=${JSON.stringify(profileDir)} \\\n` +
    `    --remote-debugging-port=${port} \\\n` +
    `    --no-first-run --no-default-browser-check\n\n` +
    `then sign in to the notetaker account in that window and leave it open.`
  );
}

/** The port from a CDP endpoint URL, for the launch hint above. Falls back to
 * the endpoint verbatim rather than to a guessed number: printing a port the
 * operator did not configure would send them to a window this run will not
 * attach to. */
function cdpPort(endpoint: string): string {
  try {
    return new URL(endpoint).port || endpoint;
  } catch {
    return endpoint;
  }
}

/** Every vendor edge preflight touches, in one object, so a test can exercise
 * each unmet prerequisite without a browser, a capture binary, or a network.
 * Defaulted for every real caller by `realPreflightDeps`. */
export interface PreflightDeps {
  /** Resolve when a DevTools endpoint answers at `endpoint`; reject otherwise.
   * Deliberately an HTTP probe rather than a Playwright connect: it costs no
   * browser process, and it lets the "nothing is listening" case carry its own
   * message instead of whatever the driver happens to throw. */
  probeCdpEndpoint(endpoint: string): Promise<void>;
  /** The audio input devices the capture binary can see, in index order. */
  listAudioInputDevices(ffmpegPath: string): Promise<string[]>;
  /** Resolve when `path` could be created and written; reject otherwise.
   *
   * OBSERVES, and does not create. Preflight runs before a meeting has been
   * joined, and the artifact writers make their own directories — so creating
   * them here would leave an empty per-run transcripts directory behind for
   * every attempt that was denied at the door. */
  probeWritable(path: string): Promise<void>;
}

/** What preflight needs to know about a run. A subset of `MeetingJoinConfig`
 * (`run.ts`) rather than the whole thing, so this module never has to be
 * handed a Deepgram key it has no use for. */
export interface PreflightSubject {
  cdpEndpoint: string;
  chromeProfileDir: string;
  audioDevice: string;
  ffmpegPath: string;
  recordsPath: string;
  transcriptsDir: string;
}

/** Every unmet prerequisite, in one throw.
 *
 * One error per problem would make an operator with three misconfigurations
 * discover them one meeting at a time. `problems` is kept as a list as well as
 * being rendered into the message so a caller can present them however it
 * likes without re-parsing prose. */
export class MeetingPreflightError extends OperatorFacingError {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      `Cannot join a meeting yet — ${problems.length} prerequisite(s) are not met:\n\n` +
        problems.map((p, i) => `${i + 1}. ${p}`).join("\n\n")
    );
    this.name = "MeetingPreflightError";
    this.problems = problems;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Indent a multi-line remedy to sit under its numbered problem — leaving
 * blank lines genuinely blank, rather than turning them into lines of
 * trailing whitespace that some terminals and most diffs then flag. */
function indentContinuation(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `   ${line}`))
    .join("\n")
    .trimStart();
}

/** Parse `ffmpeg -f avfoundation -list_devices true` output into the audio
 * device names, in the index order avfoundation itself assigned them.
 *
 * Pure and exported so the parsing is tested without running ffmpeg — the
 * binary writes this list to STDERR and then exits nonzero (listing devices is
 * not a job it can complete), so a caller that reads stdout or trusts the exit
 * code sees nothing at all. That is the whole reason this is a named function
 * rather than three lines inside the spawn callback.
 *
 * The video section is skipped rather than filtered out afterwards: both
 * sections use the same `[N] Name` shape, so a camera would otherwise read as
 * a capturable audio device and a typo'd device name could "match" it. */
export function parseAvfoundationAudioDevices(stderr: string): string[] {
  const devices: string[] = [];
  let inAudioSection = false;
  for (const line of stderr.split("\n")) {
    if (/AVFoundation audio devices:/.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/AVFoundation video devices:/.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;
    const match = /\[\d+\]\s+(.+?)\s*$/.exec(line);
    if (match) devices.push(match[1]);
  }
  return devices;
}

/** Run the capture binary's own device enumeration.
 *
 * Rejects when the binary cannot be run at all, and that rejection is NOT
 * turned into an empty device list: "ffmpeg is not installed" and "ffmpeg is
 * installed and this device is not there" are different problems with
 * different remedies, and collapsing them would tell an operator to check
 * their audio routing when the real answer is `brew install ffmpeg`. */
async function listAudioInputDevices(ffmpegPath: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${ffmpegPath} did not answer within ${DEVICE_LIST_TIMEOUT_MS}ms`));
    }, DEVICE_LIST_TIMEOUT_MS);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${ffmpegPath}: ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      // The exit code is deliberately ignored: `-list_devices true` always
      // exits nonzero because it never opens an input. The list is the output.
      resolve(parseAvfoundationAudioDevices(stderr));
    });
  });
}

async function probeCdpEndpoint(endpoint: string): Promise<void> {
  const url = new URL("/json/version", endpoint);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS) });
  } catch (error) {
    // Node's own message for a refused connection is the bare string "fetch
    // failed", which says less than the operator already knew. The `cause`
    // is where the actual syscall error lives ("connect ECONNREFUSED
    // 127.0.0.1:9444"), so it is unwrapped rather than left buried one
    // property deep in an error nobody is going to inspect by hand.
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : describe(error);
    throw new Error(`${describe(error)} (${detail})`);
  }
  if (!response.ok) {
    throw new Error(`${url.href} answered HTTP ${response.status}`);
  }
}

/** Walk up to the nearest ancestor of `path` that exists, and confirm THAT is
 * writable.
 *
 * Neither the records directory nor the per-run transcripts directory exists
 * yet on a first run, so asking whether the leaf is writable would fail every
 * healthy deployment. The nearest existing ancestor is the thing that actually
 * decides whether the rest can be created, and asking it costs no mkdir. */
async function probeWritable(path: string): Promise<void> {
  let current = path;
  for (;;) {
    try {
      await access(current, constants.W_OK);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      // Anything other than "it isn't there" is the answer: a directory that
      // exists and refuses us is exactly what this is looking for, and
      // climbing past it would find a writable ancestor and report success.
      if (code !== "ENOENT" || parent === current) throw error;
      current = parent;
    }
  }
}

export function realPreflightDeps(): PreflightDeps {
  return { probeCdpEndpoint, listAudioInputDevices, probeWritable };
}

/** Whether `configured` names one of `available`.
 *
 * An index is accepted as well as a name because that is what avfoundation's
 * own `-i ":<n>"` syntax takes, and an operator reading ffmpeg's list sees the
 * indices first. Bounds-checked rather than passed through, since an
 * out-of-range index is the same misconfiguration as an unknown name and must
 * not reach the capture. */
function deviceIsPresent(configured: string, available: readonly string[]): boolean {
  if (/^\d+$/.test(configured)) {
    const index = Number(configured);
    return index >= 0 && index < available.length;
  }
  return available.includes(configured);
}

function renderDeviceList(available: readonly string[]): string {
  return available.map((name, i) => `     [${i}] ${name}`).join("\n");
}

/**
 * Check every prerequisite an operator can get wrong before a meeting starts,
 * and report ALL of them at once.
 *
 * Called before anything is opened, dialled or captured. Each problem names
 * what to do about itself: a stack trace at the moment a meeting is starting
 * is a failed meeting, and "connection refused" is a stack trace with better
 * manners.
 *
 * Every check runs even when an earlier one has already failed — an operator
 * setting this up for the first time typically has more than one thing to fix,
 * and discovering them one meeting at a time is the cost of failing on the
 * first.
 */
export async function preflightMeeting(
  subject: PreflightSubject,
  deps: PreflightDeps = realPreflightDeps()
): Promise<void> {
  const problems: string[] = [];

  const results = await Promise.allSettled([
    deps.probeWritable(dirname(subject.recordsPath)),
    deps.probeWritable(subject.transcriptsDir),
    deps.listAudioInputDevices(subject.ffmpegPath),
    deps.probeCdpEndpoint(subject.cdpEndpoint)
  ]);
  const [records, transcripts, devices, cdp] = results;

  if (records.status === "rejected") {
    problems.push(
      `The records file cannot be written: ${subject.recordsPath}\n` +
        `   ${describe(records.reason)}\n` +
        `   Every join attempt appends a record here, including a failed one, so a run that\n` +
        `   cannot write it produces no evidence at all. Point --records-path (or\n` +
        `   PARLEY_CALL_RECORDS_PATH) at a directory this user can write, or fix its\n` +
        `   permissions.`
    );
  }

  if (transcripts.status === "rejected") {
    // Checked separately from the records path, and not folded into it: the
    // transcripts directory is independently configurable
    // (--transcripts-dir), and `emitMeetingArtifacts` writes the transcript
    // BEFORE it appends the record — so a directory that refuses the write
    // costs the meeting BOTH artifacts, discovered after the meeting rather
    // than before it.
    problems.push(
      `The transcript cannot be written under: ${subject.transcriptsDir}\n` +
        `   ${describe(transcripts.reason)}\n` +
        `   The transcript is written before the record is appended, so a directory that\n` +
        `   refuses it costs this meeting both. Point --transcripts-dir (or\n` +
        `   PARLEY_MEET_TRANSCRIPTS_DIR) somewhere this user can write.`
    );
  }

  if (devices.status === "rejected") {
    problems.push(
      `The audio capture binary could not be run: ${subject.ffmpegPath}\n` +
        `   ${describe(devices.reason)}\n` +
        `   Install ffmpeg, or point --ffmpeg-path (or PARLEY_MEET_FFMPEG_PATH) at it. Without\n` +
        `   it there is no meeting audio to transcribe.`
    );
  } else if (devices.value.length === 0) {
    // A DIFFERENT problem from "that device is not there", and it was worth
    // separating: on an empty list, "set --audio-device to one of these
    // names" points at nothing, so the message tells the operator to pick
    // from a list that is not there. It is also a common state on a fresh
    // host rather than an exotic one — macOS withholds every audio input
    // from a process that has not been granted microphone access, and the
    // list comes back empty rather than denied.
    problems.push(
      `${subject.ffmpegPath} ran, but reports NO audio input devices at all — so there is\n` +
        `   nothing to capture the meeting from, whatever --audio-device is set to.\n` +
        `   On macOS this is usually one of two things: the terminal running this has not\n` +
        `   been granted microphone access (System Settings › Privacy & Security ›\n` +
        `   Microphone), or no loopback device is installed to route the meeting's audio\n` +
        `   into. Confirm with:\n` +
        `     ${subject.ffmpegPath} -f avfoundation -list_devices true -i ""`
    );
  } else if (!deviceIsPresent(subject.audioDevice, devices.value)) {
    problems.push(
      `No audio input device named ${JSON.stringify(subject.audioDevice)} is present.\n` +
        `   The capture binary can see these:\n${renderDeviceList(devices.value)}\n` +
        `   Set --audio-device (or PARLEY_MEET_AUDIO_DEVICE) to one of those names, or to its\n` +
        `   index. This must be the loopback device the meeting's audio is routed to — a\n` +
        `   microphone captures the room, not the call.`
    );
  }

  if (cdp.status === "rejected") {
    problems.push(
      `No Chrome DevTools endpoint answered at ${subject.cdpEndpoint}\n` +
        `   ${describe(cdp.reason)}\n` +
        `   ${indentContinuation(chromeLaunchHint(subject.chromeProfileDir, subject.cdpEndpoint))}`
    );
  }

  if (problems.length > 0) throw new MeetingPreflightError(problems);
}

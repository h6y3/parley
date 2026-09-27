import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { TranscriptEvent } from "@parley/core";
import { PCM_16K } from "@parley/core";
import { createDeepgramTranscriptionProvider } from "@parley/transcription-deepgram";
import { DEFAULT_FFMPEG_PATH, startAudioTap } from "./audio-tap.js";
import { googleMeetAdapter } from "./google-meet.js";
import { OperatorFacingError } from "./operator-error.js";
import { dispatchPostCall } from "./post-call.js";
import { preflightMeeting, realPreflightDeps, type PreflightDeps } from "./preflight.js";
import { runBrowserMeeting, type BrowserMeetingResult, type SessionDeps } from "./session.js";
import { TranscriptionInterruptedError } from "./transcription-interrupted.js";

/** The endpoint `docs/profile-setup.md` tells the operator to open Chrome on.
 * A default rather than a required flag because the setup document already
 * fixes it: a CLI that demanded a value the document has already chosen would
 * make every operator retype the doc, and a CLI that chose a DIFFERENT one
 * would silently disagree with it. Overridable by flag and by environment. */
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

/** Same reasoning as `DEFAULT_CDP_ENDPOINT`: `docs/profile-setup.md`'s
 * `--user-data-dir`. Relative to the caller's HOME rather than absolute,
 * because this package must not name one machine's user. */
export function defaultChromeProfileDir(home: string): string {
  return join(home, ".config", "parley", "meet-profile");
}

/** Everything one `meeting join` run needs. Assembled from flags and the
 * environment by `resolveMeetingJoinConfig`; nothing in this module reads
 * `process.env` itself, and neither does `session.ts` — the environment is
 * read once, in the CLI's entry point, and travels from there as data. */
export interface MeetingJoinConfig {
  url: string;
  /** No default anywhere in this package, deliberately. The display name is
   * what appears in the participant list, and this transport speaks no
   * announcement — so it is the ONLY disclosure to the room that a notetaker
   * is present. A library that picked one would be choosing, on a
   * deployment's behalf, what a room is told about being recorded. */
  displayName: string;
  cdpEndpoint: string;
  chromeProfileDir: string;
  recordsPath: string;
  transcriptsDir: string;
  audioDevice: string;
  ffmpegPath: string;
  deepgramApiKey: string;
  /** `PARLEY_POST_CALL_COMMAND`, resolved HERE and passed down. Undefined is a
   * valid deployment: the artifacts are still written and nothing consumes
   * them. */
  postCallCommand: string | undefined;
  maxMeetingSeconds?: number;
  /** See `BrowserMeetingConfig.endedConfirmSeconds` (`types.ts`) for what
   * this trades off, and `HAS_ENDED_CONFIRM_MS` (`join-driver.ts`) for the
   * default and why it is the number it is. */
  endedConfirmSeconds?: number;
}

export const MEETING_JOIN_USAGE = [
  "Usage: parley meeting join <meeting-url> [options]",
  "",
  "Joins a video meeting in a Chrome window YOU started by hand (see",
  "packages/meeting-browser/docs/profile-setup.md), captures its audio, transcribes it,",
  "and writes a meeting record plus a transcript.",
  "",
  "Required (flag, or the environment variable beside it):",
  "  --display-name <name>      PARLEY_MEET_DISPLAY_NAME",
  "                             The name the room sees. There is no default: this",
  "                             transport makes no spoken announcement, so this name is",
  "                             the entire disclosure that a notetaker joined.",
  "  --records-path <file>      PARLEY_CALL_RECORDS_PATH",
  "                             JSONL file every join attempt appends one record to.",
  "  --audio-device <name|idx>  PARLEY_MEET_AUDIO_DEVICE",
  "                             The loopback input device carrying the meeting's audio,",
  "                             as the capture binary lists it.",
  "  (no flag)                  DEEPGRAM_API_KEY",
  "                             Environment only, never a flag: argv is readable by every",
  "                             process on this host.",
  "",
  "Optional:",
  `  --cdp-endpoint <url>       PARLEY_MEET_CDP_ENDPOINT   (default ${DEFAULT_CDP_ENDPOINT})`,
  "  --profile-dir <dir>        PARLEY_MEET_PROFILE_DIR    (default $HOME/.config/parley/meet-profile)",
  "  --transcripts-dir <dir>    PARLEY_MEET_TRANSCRIPTS_DIR",
  "                             (default: a fresh directory per run, beside the records file)",
  `  --ffmpeg-path <path>       PARLEY_MEET_FFMPEG_PATH    (default ${DEFAULT_FFMPEG_PATH})`,
  "  --max-seconds <n>          Ceiling on the meeting's length.",
  "  --ended-confirm-seconds <n>  PARLEY_MEET_ENDED_CONFIRM_SECONDS",
  "                             How long the meeting UI must look gone before this run",
  "                             believes the meeting ended. Raise it on a flaky link: a page",
  "                             blackout shorter than this cannot truncate the meeting.",
  "",
  "PARLEY_POST_CALL_COMMAND, if set, is run once the meeting ends with",
  "--records-path <file> --call-id <meeting id>."
].join("\n");

/** A configuration mistake, stated as an instruction rather than as a stack.
 * See `OperatorFacingError`. */
export class MeetingConfigError extends OperatorFacingError {
  constructor(message: string) {
    super(`${message}\n\n${MEETING_JOIN_USAGE}`);
    this.name = "MeetingConfigError";
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  // A flag with nothing after it is a typo, not a request for the default.
  // Silently defaulting is how a run joins under the wrong name.
  if (value === undefined || value.startsWith("--")) {
    throw new MeetingConfigError(`${name} needs a value.`);
  }
  return value;
}

function required(
  value: string | undefined,
  what: string,
  flagName: string,
  envName: string,
  why: string
): string {
  if (value !== undefined && value !== "") return value;
  throw new MeetingConfigError(
    `${what} is not configured. Set ${flagName} <value>, or the ${envName} environment ` +
      `variable.\n${why}`
  );
}

/** A duration flag, in seconds, or `undefined` when it was not supplied.
 *
 * Shared by every seconds-valued option rather than open-coded per flag: each
 * copy is another chance to accept a `NaN` (`Number("2m")`) or a negative, and
 * both reach the session as a ceiling or a tolerance that can never be met. */
function positiveSeconds(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new MeetingConfigError(
      `${flagName} must be a positive number, got ${JSON.stringify(raw)}.`
    );
  }
  return value;
}

/** A directory this run, and only this run, writes its transcript into.
 *
 * `writeTranscriptJsonl` names the file `transcript.jsonl` inside whatever
 * directory it is given, so a records-relative directory shared by every
 * meeting means the second meeting silently overwrites the first one's
 * transcript. The record is the index that makes this discoverable: it carries
 * the exact `transcriptPath`, so a per-run directory costs a reader nothing
 * and costs a second meeting nothing either.
 *
 * The date partition matches the telephony transport's convention
 * (`meetingTranscriptDir`), so both transports' transcripts sort together. The
 * suffix is random rather than a counter because a counter is per-process, and
 * two processes writing beside one records file is exactly the case a counter
 * cannot cover. */
function defaultTranscriptsDir(recordsPath: string, startedAt: Date, runId: string): string {
  return join(dirname(recordsPath), "meetings", startedAt.toISOString().slice(0, 10), runId);
}

export interface ResolveDeps {
  now?: () => number;
  runId?: () => string;
}

/**
 * Turn `meeting join`'s argv and the process environment into one config.
 *
 * Pure: it reads the `env` it is handed and never `process.env`, so the
 * environment is read in exactly one place (the CLI entry point) and every
 * resolution rule here is testable without mutating the process.
 *
 * Flags win over the environment, because a flag is what an operator typed for
 * THIS run. Every missing required value names both ways to supply it and says
 * why it exists — an operator meets these errors while a meeting is starting.
 */
export function resolveMeetingJoinConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: ResolveDeps = {}
): MeetingJoinConfig {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "join") {
    throw new MeetingConfigError(`Unknown meeting subcommand ${JSON.stringify(subcommand ?? "")}.`);
  }
  const url = rest.find((a) => !a.startsWith("--"));
  if (url === undefined) {
    throw new MeetingConfigError("meeting join needs a meeting URL.");
  }

  const displayName = required(
    flag(rest, "--display-name") ?? env.PARLEY_MEET_DISPLAY_NAME,
    "The display name",
    "--display-name",
    "PARLEY_MEET_DISPLAY_NAME",
    "It is the name every participant sees, and this transport makes no spoken " +
      "announcement — so it is the only disclosure to the room that a notetaker is present. " +
      "There is deliberately no default: choosing one would decide, for you, what the room " +
      "is told."
  );
  const recordsPath = required(
    flag(rest, "--records-path") ?? env.PARLEY_CALL_RECORDS_PATH,
    "The records path",
    "--records-path",
    "PARLEY_CALL_RECORDS_PATH",
    "Every join attempt appends one record there, including a failed one — without it a " +
      "failed meeting is invisible rather than reported."
  );
  const audioDevice = required(
    flag(rest, "--audio-device") ?? env.PARLEY_MEET_AUDIO_DEVICE,
    "The audio capture device",
    "--audio-device",
    "PARLEY_MEET_AUDIO_DEVICE",
    "It must be the loopback device the meeting's audio is routed to. There is no default " +
      "because a wrong guess captures the room the host machine is sitting in rather than " +
      "the call."
  );
  const deepgramApiKey = env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) {
    throw new MeetingConfigError(
      "DEEPGRAM_API_KEY is not set, so there is no transcription plane and the meeting " +
        "would be recorded as silence. Export it before joining. It is read from the " +
        "environment only and is deliberately not a flag: argv is readable by every " +
        "process on this host."
    );
  }

  const maxMeetingSeconds = positiveSeconds(flag(rest, "--max-seconds"), "--max-seconds");
  const endedConfirmSeconds = positiveSeconds(
    flag(rest, "--ended-confirm-seconds") ?? env.PARLEY_MEET_ENDED_CONFIRM_SECONDS,
    "--ended-confirm-seconds"
  );

  const now = deps.now ?? Date.now;
  const runId = (deps.runId ?? (() => randomUUID().replaceAll("-", "").slice(0, 8)))();

  return {
    url,
    displayName,
    cdpEndpoint:
      flag(rest, "--cdp-endpoint") ?? env.PARLEY_MEET_CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT,
    chromeProfileDir:
      flag(rest, "--profile-dir") ??
      env.PARLEY_MEET_PROFILE_DIR ??
      defaultChromeProfileDir(env.HOME ?? ""),
    recordsPath,
    transcriptsDir:
      flag(rest, "--transcripts-dir") ??
      env.PARLEY_MEET_TRANSCRIPTS_DIR ??
      defaultTranscriptsDir(recordsPath, new Date(now()), runId),
    audioDevice,
    ffmpegPath: flag(rest, "--ffmpeg-path") ?? env.PARLEY_MEET_FFMPEG_PATH ?? DEFAULT_FFMPEG_PATH,
    deepgramApiKey,
    postCallCommand: env.PARLEY_POST_CALL_COMMAND,
    ...(maxMeetingSeconds === undefined ? {} : { maxMeetingSeconds }),
    ...(endedConfirmSeconds === undefined ? {} : { endedConfirmSeconds })
  };
}

/** The slice of Playwright's `Browser` this module drives, named structurally
 * so nothing here depends on Playwright's types and every test can hand in a
 * stand-in. */
export interface CdpBrowserContext {
  newPage(): Promise<unknown>;
}
/** The one method this module calls on the page it opened. Structural for the
 * same reason everything else here is: a real Playwright `Page` satisfies it,
 * and so does a test stand-in that never launches a browser. */
export interface ClosablePage {
  close(): Promise<void>;
}
export interface CdpBrowser {
  contexts(): CdpBrowserContext[];
  close(): Promise<void>;
}
export type ConnectOverCdp = (endpoint: string) => Promise<CdpBrowser>;

/** Attach to a Chrome the operator started, over CDP. NEVER launch one.
 *
 * `docs/profile-setup.md` explains at length why: Google refuses sign-in to a
 * browser Playwright launched, because a launched Chromium carries automation
 * markers an ordinary session does not. An attached window carries none — it
 * is a normal Chrome window that something is merely watching. That is why the
 * setup is a documented manual procedure and why there is no `launch` anywhere
 * in this package.
 *
 * Playwright is imported lazily, inside the call, for two reasons: it is a
 * heavy module nothing else in this package needs, and importing it eagerly
 * would put it on the module graph of every consumer that only wants the pure
 * parts (`attributeEvents`, the adapter's selectors, the record emitter). */
export function realConnectOverCdp(): ConnectOverCdp {
  return async (endpoint: string): Promise<CdpBrowser> => {
    const { chromium } = await import("playwright");
    return (await chromium.connectOverCDP(endpoint)) as unknown as CdpBrowser;
  };
}

/** How the transcription plane is reached, as one injectable function.
 *
 * Named separately from `SessionDeps.transcribe` because this one still needs
 * the meeting-relative offset, which only the session's own clock knows — see
 * `createMeetingSession`. */
export type ConnectTranscription = (
  offsetMs: number,
  callbacks: { onTranscript: (event: TranscriptEvent) => void; onError: (message: string) => void }
) => Promise<{
  sendAudio(frame: Buffer): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}>;

/** Bind the Deepgram transcription provider to this run's key.
 *
 * `interimResults: false` — the transcript writer drops non-final events
 * outright ("interims are a wire concern, never a record"), so asking for them
 * buys nothing but traffic. `diarize: false` — attribution here comes from the
 * meeting's own captions and the transcript header states `diarized: false`;
 * asking Deepgram to diarize as well would make that header a lie. */
export function realConnectTranscription(apiKey: string): ConnectTranscription {
  const provider = createDeepgramTranscriptionProvider({ apiKey });
  return async (offsetMs, callbacks) => {
    const session = await provider.connect({
      encoding: PCM_16K,
      channels: 1,
      interimResults: false,
      wordTimestamps: true,
      diarize: false,
      offsetMs,
      callbacks: {
        onTranscript: callbacks.onTranscript,
        onError: (error) => callbacks.onError(error.message),
        onClose: () => {}
      }
    });
    return {
      sendAudio: (data: Buffer) => {
        session.sendAudio({ encoding: PCM_16K, data });
      },
      flush: () => session.flush(),
      close: () => session.close()
    };
  };
}

/** How the audio tap is started, as one injectable function — so a test can
 * assert the configured device name reaches it without opening a device. */
export type StartTap = (
  device: string,
  ffmpegPath: string
) => { frames: AsyncIterable<Buffer>; stop(): Promise<void> };

export function realStartTap(): StartTap {
  return (device, ffmpegPath) => startAudioTap({ device, ffmpegPath });
}

/** Every vendor edge the composition root binds. Defaulted to the real
 * implementations; replaced wholesale by the tests, which launch no browser,
 * open no device and make no network call — what those tests are about is the
 * composition, not Playwright and not Deepgram. */
export interface MeetingRuntimeDeps {
  connectOverCdp: ConnectOverCdp;
  connectTranscription: ConnectTranscription;
  startTap: StartTap;
  dispatch: typeof dispatchPostCall;
  clock: () => number;
}

export function realRuntimeDeps(config: MeetingJoinConfig): MeetingRuntimeDeps {
  return {
    connectOverCdp: realConnectOverCdp(),
    connectTranscription: realConnectTranscription(config.deepgramApiKey),
    startTap: realStartTap(),
    dispatch: dispatchPostCall,
    clock: Date.now
  };
}

export interface MeetingSession {
  deps: SessionDeps;
  /** Disconnect from the operator's Chrome. Their window — which nothing here
   * launched — stays open either way; this only drops Playwright's CDP
   * connection, which otherwise holds the process's event loop open forever.
   * Safe to call whether or not anything was ever connected. */
  close(): Promise<void>;
}

/**
 * The composition root: bind every real implementation into a `SessionDeps`.
 *
 * This is the one place that knows Google Meet is the adapter, that the page
 * comes from an attached Chrome, that audio comes from a capture binary, that
 * transcription is Deepgram, and that the post-call hook is
 * `PARLEY_POST_CALL_COMMAND`. `session.ts` knows none of it, which is what
 * lets its own tests inject fakes rather than mutate the environment — and is
 * why the environment is read in the CLI and travels here as `config`.
 */
export function createMeetingSession(
  config: MeetingJoinConfig,
  deps: MeetingRuntimeDeps = realRuntimeDeps(config)
): MeetingSession {
  let browser: CdpBrowser | undefined;

  /** The session's own t0, learned from the first `now()` it asks for.
   *
   * `runBrowserMeeting`'s first statement is `const t0 = deps.now()`, and
   * every time it reports — the record's `startedAt`, the caption cues'
   * `atMs`, the transcript's `msSinceStartedAt` base — is relative to that
   * instant. The transcription plane, by contrast, starts its own clock at
   * zero when the tap opens, which is AFTER the join and the captions toggle:
   * on a meeting with a waiting room that gap is minutes. Left at zero the
   * two time bases differ by the whole join duration, `attributeEvents`'
   * three-second window never matches anything, and every utterance comes back
   * unattributed while both halves look individually healthy.
   *
   * Observing t0 here rather than being handed it is a coupling to that call
   * order, and it is pinned by a test for exactly that reason. */
  let sessionT0: number | undefined;
  let tapStartedAt: number | undefined;

  const now = (): number => {
    const t = deps.clock();
    sessionT0 ??= t;
    return t;
  };

  return {
    deps: {
      openPage: async (): Promise<unknown> => {
        browser = await deps.connectOverCdp(config.cdpEndpoint);
        // `contexts()[0]`, never `browser.newPage()`. On a CDP connection the
        // first context IS the operator's signed-in profile; `newPage()` on
        // the browser makes a fresh context instead, which carries none of
        // that session and would land on a sign-in wall. A NEW page in that
        // context rather than an existing one, so whatever the operator has
        // open is not navigated away from underneath them.
        const context = browser.contexts()[0];
        if (context === undefined) {
          throw new Error(
            `Attached to Chrome at ${config.cdpEndpoint}, but it has no browser context to ` +
              `open a page in. That window is not usable — start one following ` +
              `packages/meeting-browser/docs/profile-setup.md and try again.`
          );
        }
        return context.newPage();
      },

      // ONLY the page `openPage` opened. Not `browser.close()` — that is
      // `MeetingSession.close` below, and even there it merely disconnects —
      // and not the context, which IS the operator's signed-in profile and
      // holds whatever tabs they had open. This transport attaches to a
      // Chrome a human started by hand; the single tab it opened itself is
      // the only thing it is entitled to close.
      closePage: async (page: unknown): Promise<void> => {
        const candidate = page as Partial<ClosablePage> | null | undefined;
        if (typeof candidate?.close !== "function") {
          // Reported rather than ignored. A page that cannot be closed is a
          // notetaker left in the participant list, which is the exact
          // failure this teardown exists to prevent — and `session.ts` guards
          // this call, so the throw becomes a `captureFault` on a record that
          // still gets written.
          throw new Error(
            "meeting teardown: the page this transport opened has no close() method, so the " +
              "notetaker cannot be removed from the meeting. That page came from " +
              "context.newPage() on the attached Chrome and should be a Playwright Page."
          );
        }
        await candidate.close();
      },

      adapter: googleMeetAdapter,

      startTap: () => {
        // ONE reading of one instant, handed to both readers of it: the
        // transcriber's clock offset below, and the session's coverage
        // window (`SessionDeps.startTap`). Two readings would be two answers
        // to "when did capture begin", and the record's `coveredMs` would
        // stop being measured against the same origin as the transcript's
        // timestamps the moment they drifted.
        const startedAtMs = deps.clock();
        tapStartedAt = startedAtMs;
        const tap = deps.startTap(config.audioDevice, config.ffmpegPath);
        return { frames: tap.frames, stop: () => tap.stop(), startedAtMs };
      },

      transcribe: async (frames: AsyncIterable<Buffer>): Promise<TranscriptEvent[]> => {
        // See `sessionT0`. Both instants are known by the time this runs:
        // `session.ts` calls `startTap()` on the line before `transcribe()`.
        //
        // And if one of them is NOT, this throws — because there is no
        // correct value to fall back to. The fallbacks that used to be here
        // (`?? sessionT0 ?? 0`, then `Math.max(0, …)`) each produced a
        // number, and each number was silently catastrophic: a missing t0
        // yielded an epoch-scale offset, a missing tap instant yielded 0,
        // and either way EVERY cue misses `attributeEvents`' three-second
        // window, all attribution vanishes from the transcript, and nothing
        // anywhere errors. That is the exact failure this offset exists to
        // prevent, arrived at by the code meant to prevent it.
        if (sessionT0 === undefined) {
          throw new Error(
            "meeting transcription: the session's clock has not been read yet, so the " +
              "transcriber's time base cannot be computed. transcribe() must run after the " +
              "session's first now() — a guessed offset would leave every utterance " +
              "unattributed with nothing reporting a fault."
          );
        }
        if (tapStartedAt === undefined) {
          throw new Error(
            "meeting transcription: the audio tap has not been started, so the transcriber's " +
              "time base cannot be computed. transcribe() must run after startTap() — a " +
              "guessed offset would leave every utterance unattributed with nothing reporting " +
              "a fault."
          );
        }
        const offsetMs = tapStartedAt - sessionT0;
        if (offsetMs < 0) {
          // Impossible on a monotonic clock read in this order, so reaching
          // it means the host's clock stepped backwards mid-join. Clamping
          // to 0 (which `Math.max` did) discards the whole join duration and
          // silently unattributes the meeting; there is no repair, only a
          // report.
          throw new Error(
            `meeting transcription: the audio tap reports starting ${-offsetMs}ms before the ` +
              "session did, which means the clock moved backwards between the two readings. " +
              "Refusing to guess a time base for the transcript."
          );
        }
        const events: TranscriptEvent[] = [];
        const errors: string[] = [];
        const socket = await deps.connectTranscription(offsetMs, {
          onTranscript: (event) => events.push(event),
          onError: (message) => errors.push(message)
        });
        try {
          for await (const frame of frames) socket.sendAudio(frame);
          await socket.flush();
        } catch (error) {
          // The frame source died mid-meeting. Two things are true at once
          // and both have to survive: the pipeline is gone, and the
          // utterances already delivered are real. This used to keep only the
          // first — the bare rejection reached `session.ts`, whose
          // `.catch(() => [])` turned fifty-five minutes of a sixty-minute
          // meeting into an empty transcript.
          //
          // Flushed first, best-effort. What broke is the frame source, not
          // the socket, so the transcriber is usually still there holding the
          // last utterance — the one nearest the failure, and the one most
          // worth having. `flush()` is bounded by the provider's own timeout
          // and returns immediately on a socket that is already gone, so it
          // cannot hold a dead meeting open.
          await socket.flush().catch(() => {});
          throw new TranscriptionInterruptedError(error, events);
        } finally {
          // Closed on every path, including the one where the tap threw
          // mid-meeting. A rejection still propagates — `session.ts` models
          // that as `transcription_lost` and ends the meeting deliberately
          // rather than sit on a call it is no longer taking notes on.
          await socket.close().catch(() => {});
        }
        return events;
      },

      now,

      // Bound to the command HERE, at construction, exactly as `SessionDeps`
      // requires: `session.ts` never reads `process.env`, which is what lets
      // its tests inject a fake dispatcher instead of mutating the process.
      dispatchPostCall: (recordsPath: string, meetingId: string) =>
        deps.dispatch({ command: config.postCallCommand, recordsPath, meetingId })
    },

    close: async (): Promise<void> => {
      const b = browser;
      browser = undefined;
      if (b) await b.close().catch(() => {});
    }
  };
}

export interface MeetingJoinDeps {
  preflight?: PreflightDeps;
  runtime?: MeetingRuntimeDeps;
  resolve?: ResolveDeps;
}

/** A one-screen summary of what the run produced, for the operator watching
 * the terminal. Every line is a fact from the result rather than a verdict:
 * `captionsEnabled: false` is not an error, and a `captureFault` on a run that
 * still wrote a record is a fault to report rather than a failed meeting. */
export function describeMeetingResult(result: BrowserMeetingResult): string {
  return [
    `join outcome:   ${result.joinOutcome}`,
    `record:         ${result.recordsPath}`,
    `transcript:     ${result.transcriptPath ?? "(none — the join was never admitted)"}`,
    // The false branch covers captions that were never on AND captions that
    // failed part-way, which leaves a partly attributed transcript — so it
    // must not claim the transcript carries no attribution at all.
    `captions:       ${result.captionsEnabled ? "on (speech is attributed)" : "off (speaker attribution is missing or incomplete)"}`,
    ...(result.captureFault ? [`capture fault:  ${result.captureFault.message}`] : [])
  ].join("\n");
}

/** What `parley meeting join` should exit with.
 *
 * It exited 0 on every run that produced a result, which is every run that did
 * not throw — so a denied join, an expired session, a waiting-room timeout and
 * a non-null capture fault all reported success. For a scheduled notetaker the
 * exit code is the only signal a wrapper reads, and this repository's own
 * history has a hook that failed for weeks because nobody observed one.
 *
 * Three codes rather than one, because a wrapper's response differs:
 *
 * - `0` — admitted, and nothing broke. The only run that needs no attention.
 * - `2` — the meeting never happened. `joinOutcome` says which way — denied,
 *   auth_required, not_started, waiting_room_timeout (admission could not be
 *   confirmed), or join_error (the attempt threw before any verdict existed)
 *   — and a record was still written saying so. A wrapper's move here is
 *   usually to alert a human: the notetaker was expected in a meeting and is
 *   not in it.
 * - `3` — it WAS in the meeting and something broke: captions lost, the tap
 *   failed, the page stopped answering, teardown could not get it out. The
 *   artifacts exist and are worth reading; they are just incomplete.
 *
 * `1` is deliberately not used here — it stays what it already is, the code
 * the CLI's own top-level catch sets for an exception, which is a different
 * event from a meeting that ran and went badly.
 *
 * A pure function, exported, rather than three lines inside the CLI's switch:
 * this is a contract with whatever runs `parley` on a schedule, and a contract
 * nothing can test is one nothing can rely on. */
export const MEETING_EXIT_OK = 0;
export const MEETING_EXIT_NEVER_JOINED = 2;
export const MEETING_EXIT_CAPTURE_FAULT = 3;

export function meetingExitCode(result: BrowserMeetingResult): number {
  // Checked first: a run that never got in is a bigger fact than anything that
  // broke while it was not there.
  if (result.joinOutcome !== "admitted") return MEETING_EXIT_NEVER_JOINED;
  if (result.captureFault !== null) return MEETING_EXIT_CAPTURE_FAULT;
  return MEETING_EXIT_OK;
}

/**
 * `parley meeting join <url>`, end to end: resolve the configuration, check
 * every prerequisite, run the meeting, and disconnect.
 *
 * Preflight runs BEFORE anything is opened or captured, and reports every
 * unmet prerequisite at once. Teardown runs whether the meeting ended or
 * threw: an abandoned CDP connection holds the process's event loop open, so a
 * missing `finally` here is a `parley` that records the meeting correctly and
 * then never exits.
 */
export async function runMeetingJoin(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: MeetingJoinDeps = {}
): Promise<BrowserMeetingResult> {
  const config = resolveMeetingJoinConfig(argv, env, deps.resolve);
  await preflightMeeting(config, deps.preflight ?? realPreflightDeps());

  const session = createMeetingSession(config, deps.runtime ?? realRuntimeDeps(config));
  try {
    return await runBrowserMeeting(
      {
        url: config.url,
        displayName: config.displayName,
        chromeProfileDir: config.chromeProfileDir,
        recordsPath: config.recordsPath,
        transcriptsDir: config.transcriptsDir,
        ...(config.maxMeetingSeconds === undefined
          ? {}
          : { maxMeetingSeconds: config.maxMeetingSeconds }),
        ...(config.endedConfirmSeconds === undefined
          ? {}
          : { endedConfirmSeconds: config.endedConfirmSeconds })
      },
      session.deps
    );
  } finally {
    await session.close();
  }
}

import { spawn } from "node:child_process";

/** How much of the capture process's stderr is retained for the failure
 * message, in characters. Enough to hold ffmpeg's banner and a long tail of
 * repeated warnings; small enough that a two-hour meeting cannot grow it into
 * a leak. */
const MAX_STDERR_CHARS = 8192;

/** Where the capture binary lives on a Homebrew macOS install.
 *
 * Exported rather than inlined below because the composition root (`run.ts`)
 * resolves it once and hands the SAME value to preflight's device enumeration
 * and to this tap. Two copies of the path could drift, and the failure that
 * produces is the quiet kind: preflight would confirm a device on one ffmpeg
 * while the capture opened another that has never heard of it. */
export const DEFAULT_FFMPEG_PATH = "/opt/homebrew/bin/ffmpeg";

/** How long a SIGTERMed capture is given to exit on its own before SIGKILL,
 * and how long after SIGKILL before `stop()` gives up and reports.
 *
 * `stop()` used to send SIGTERM and resolve in the same breath, which is a
 * promise about the SIGNAL rather than about the process. Two consequences,
 * both real: the caller wrote the meeting's record while ffmpeg was still
 * capturing all system audio, and a capture wedged on a device that will not
 * release it was never sent anything stronger, so it outlived the run that
 * started it. `preflight.ts` already SIGKILLs its own child when it stops
 * answering; this is the same escalation for the longer-lived process.
 *
 * Two seconds each: ffmpeg's own teardown on a SIGTERM is milliseconds (a
 * capture stopped 700ms in closes immediately, code 255), so this is generous
 * for a healthy exit and short enough that teardown is not held up by an
 * unhealthy one. The total is bounded at four seconds, after which `stop()`
 * throws rather than waiting on a process no signal can reach — a SIGKILLed
 * process that has still not exited is stuck in the kernel, which nothing at
 * this level can fix, and holding the record hostage to it would be the worse
 * failure. */
export const STOP_SIGTERM_GRACE_MS = 2000;
export const STOP_SIGKILL_GRACE_MS = 2000;

export interface AudioTapOptions {
  /** The macOS input device name to capture, as `avfoundation` lists it. */
  device: string;
  ffmpegPath?: string;
  sampleRateHz?: number;
}

export interface AudioTap {
  frames: AsyncIterable<Buffer>;
  stop(): Promise<void>;
}

/** Injected collaborators, defaulted for every real caller.
 *
 * Present for one reason: two of this function's three failure paths are
 * reachable from a test through a fake binary on disk, and the third — a
 * stream-level fault on the child's stdout, such as the pipe breaking
 * mid-capture — is not reachable that way at all. A capture whose most
 * consequential failure mode cannot be exercised is a capture whose error
 * handling is asserted only in prose. Mirrors `MeetingPostCallDeps`
 * (`@parley/cli`), which exists for the same reason. */
export interface AudioTapDeps {
  spawnImpl?: typeof spawn;
}

/** Capture system audio as 16 kHz mono PCM.
 *
 * MUST only be started after the join driver reports `admitted` (Decision 4):
 * macOS has no per-application output routing, so this captures ALL system
 * audio. Started before admission, a failed join would quietly transcribe
 * whatever room the host machine is sitting in.
 *
 * Every failure path here throws. A capture that degrades to "no frames"
 * produces a meeting that reads as silent, which is indistinguishable from a
 * genuinely quiet meeting and therefore undetectable after the fact.
 *
 * A deliberate `stop()` is NOT a failure path, and the exit code cannot tell
 * you which one you are looking at — see `stopping` below.
 */
export function startAudioTap(opts: AudioTapOptions, deps: AudioTapDeps = {}): AudioTap {
  const ffmpegPath = opts.ffmpegPath ?? DEFAULT_FFMPEG_PATH;
  const rate = opts.sampleRateHz ?? 16000;
  const child = (deps.spawnImpl ?? spawn)(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      `:${opts.device}`,
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-f",
      "s16le",
      "-"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    // Bounded, keeping the END. A meeting runs for up to two hours and a
    // capture that is failing rather than dead — a device disconnecting and
    // redetecting, a resampler complaining once a frame — logs for all of it,
    // into a string that is never read until the process exits and never
    // freed until then either. Unbounded, the diagnostic buffer outgrows the
    // audio it is describing.
    //
    // The MOST RECENT output is what a diagnostic needs: the message this is
    // read for names the exit, and the lines nearest the exit are the ones
    // that explain it. An opening banner truncated away costs nothing; the
    // last line before the process died is the whole reason to keep any.
    stderr = (stderr + d.toString()).slice(-MAX_STDERR_CHARS);
  });

  // These are two independent signals, not one:
  //   - `error`: the process never started at all (bad path, EACCES, ...).
  //   - `close`: the process ran and terminated, with an exit code.
  // Rejecting `error` and only ever *resolving* `close` (never rejecting
  // it) means a stray settle can't jump the queue: if the exit was clean
  // the generator falls through to the code check below and returns
  // normally instead of being raced against a promise that never fires.
  //
  // Registered HERE, in this function's synchronous body, and NOT inside the
  // generator below. A generator body does not begin executing until the
  // caller's first `.next()`, so a caller that does any async work at all
  // between `startAudioTap()` and its first `for await` used to leave a
  // window with no `error` listener attached — and an `error` event with no
  // listener is not a rejection Node hands back, it is an UNCAUGHT
  // EXCEPTION. The caller had no catch block that could have stopped it,
  // whatever it wrote. Attaching before returning closes the window
  // entirely: by the time the caller holds the tap, both listeners are on.
  const errorPromise = new Promise<never>((_, reject) => {
    child.on("error", (err) =>
      reject(new Error(`audio tap could not start ${ffmpegPath}: ${err.message}`))
    );
  });
  // A promise that no one ever awaits still gets flagged as an unhandled
  // rejection if it rejects after its one real consumer below has already
  // moved on — and now that this is created eagerly, "no one ever awaits it"
  // includes a caller that never consumes the tap at all. Marking it handled
  // here doesn't stop it being raced later.
  errorPromise.catch(() => {});

  const closePromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  /** Resolves when the PROCESS terminates.
   *
   * Distinct from `closePromise`, which also waits for the child's stdio to
   * close — and a stdout a consumer has stopped reading can hold that pending
   * long after the process is gone. "Is the process gone" is the only
   * question `stop()` asks, so it asks the event that answers exactly that,
   * and the generator keeps `close` because it wants the exit CODE and cannot
   * report one until the stream it was reading has finished. */
  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });

  /** Whether the exit about to happen is one WE asked for.
   *
   * This exists because the capture binary's own exit code cannot answer that
   * question. Measured against the real ffmpeg on this host: a capture
   * SIGTERMed after 700 ms of frames closes with `{ code: 255, signal: null }`.
   * ffmpeg installs a handler for SIGTERM and exits through its own teardown,
   * so the kernel never reports a signal to us — and 255 is the same "it went
   * wrong" code a genuinely dead capture returns.
   *
   * So a flag, and NOT a match on `signal === "SIGTERM"`, for two reasons.
   * First, there is no signal to match on: it arrives as `null` for exactly
   * the reason above, so that test would never fire and every deliberate stop
   * would go on reading as a failure. Second, it would be the wrong question
   * even where it did fire — a SIGTERM this process did not send (an
   * operator's `kill`, a supervisor shutting the host down) is a capture that
   * really was cut off, and swallowing it would turn a lost meeting into a
   * clean one. "`stop()` was called" is the fact the caller actually needs.
   *
   * The cost, stated: once a stop has been asked for, a nonzero exit is no
   * longer inspected, so a device that failed in the same instant we asked to
   * stop is reported as a clean stop. That window is one teardown long, and
   * the frames already delivered are unaffected either way. */
  let stopping = false;

  async function* iterate(): AsyncGenerator<Buffer> {
    const stream = child.stdout[Symbol.asyncIterator]();
    for (;;) {
      // The raw stream error is rethrown NAMING THE DEVICE, like the other
      // two failure paths. Unwrapped it reads "Error: EPIPE" — true, and
      // useless on a host capturing one of several devices, where the whole
      // question is which capture died. All three messages now start "audio
      // tap" and carry the device or the binary they were about.
      const next = await Promise.race([
        stream.next().catch((err: unknown): IteratorResult<Buffer> => {
          // Tearing a capture down is allowed to break its own pipe: killing
          // the child is what closes stdout. A stream fault AFTER `stop()` is
          // therefore the teardown itself rather than a lost meeting, and is
          // reported as a clean end of stream — the exit check below, which
          // reads the same flag, has the last word.
          if (stopping) return { done: true, value: undefined };
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `audio tap lost the stream from device ${JSON.stringify(opts.device)}: ${detail}`
          );
        }),
        errorPromise
      ]);
      if (next.done) break;
      yield next.value as Buffer;
    }

    // stdout ending does NOT by itself mean the capture succeeded: a process
    // that dies immediately after writing nothing also ends its stdout. Only
    // the exit code (or a start-up error, if it wins this second race) tells
    // us which one happened, so the generator does not return "clean" until
    // it has actually checked.
    const code = await Promise.race([closePromise, errorPromise]);
    // See `stopping`. EVERY normally-ended meeting reaches this line, and
    // before this check every one of them threw here: the throw came out of
    // the consumer's `for await`, which skipped the transcriber's flush,
    // which failed the whole transcription — so a meeting that ended
    // perfectly normally wrote an empty transcript under a record calling
    // itself complete.
    if (stopping) return;
    if (code !== 0 && code !== null) {
      throw new Error(
        `audio tap exited ${code} capturing device ${JSON.stringify(opts.device)}: ` +
          (stderr.trim() || "no stderr")
      );
    }
  }

  /** Whether the capture process has exited within `ms`. Clears its own timer
   * when the exit wins, so a clean stop leaves nothing armed behind it. */
  function exitedWithin(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);
      void exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  return {
    frames: iterate(),
    async stop() {
      // Marked BEFORE the signal is sent, never after: the child can exit
      // between the two statements, and a flag set afterwards would be read
      // by a generator that has already decided the exit was a failure.
      stopping = true;

      // Nothing to signal and nothing to wait for. `pid` is undefined when the
      // spawn itself failed, in which case no `close` may ever arrive; a
      // settled exit code or signal means the process is already gone. Without
      // this, a tap that never started would hold its caller for the full
      // escalation and then report a process that never existed.
      if (child.pid === undefined) return;
      if (child.exitCode !== null || child.signalCode !== null) return;

      // AWAITED, not fired and forgotten. This resolved the instant the signal
      // was sent, so the caller went on to write the meeting's record while
      // ffmpeg was still capturing all system audio.
      child.kill("SIGTERM");
      if (await exitedWithin(STOP_SIGTERM_GRACE_MS)) return;

      // A capture wedged on a device that will not release it never received
      // anything stronger than the SIGTERM it was ignoring, and outlived the
      // run that started it.
      child.kill("SIGKILL");
      if (await exitedWithin(STOP_SIGKILL_GRACE_MS)) return;

      throw new Error(
        `audio tap for device ${JSON.stringify(opts.device)} did not exit after SIGTERM and ` +
          `SIGKILL (pid ${child.pid}). It may still be holding the device and capturing audio.`
      );
    }
  };
}

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { STOP_SIGKILL_GRACE_MS, STOP_SIGTERM_GRACE_MS, startAudioTap } from "../src/audio-tap.js";
import {
  SIGTERM_HANDLING_CAPTURE,
  SIGTERM_IGNORING_CAPTURE,
  SIGTERM_SLOW_EXIT_CAPTURE,
  SLOW_EXIT_MS,
  fakeFfmpeg
} from "./fake-ffmpeg.js";

describe("startAudioTap", () => {
  it("yields the frames the capture process emits", async () => {
    const bin = await fakeFfmpeg(`process.stdout.write(Buffer.alloc(640, 1)); process.exit(0);`);
    const tap = startAudioTap({ device: "TestDevice", ffmpegPath: bin });
    const chunks: Buffer[] = [];
    for await (const frame of tap.frames) chunks.push(frame);
    expect(Buffer.concat(chunks).length).toBe(640);
    await tap.stop();
  });

  it("rejects loudly when the capture process cannot start", async () => {
    const tap = startAudioTap({ device: "TestDevice", ffmpegPath: "/nonexistent/ffmpeg" });
    // A tap that fails silently is a meeting that looks silent. The whole
    // point of this check is that this must never degrade to "no frames".
    await expect(async () => {
      for await (const _ of tap.frames) void _;
    }).rejects.toThrow(/nonexistent/);
  });

  /** Every other test here begins consuming in the same synchronous
   * continuation as `startAudioTap`, so none of them can see this: a caller
   * that does ANY async work before its first `for await` leaves a window in
   * which a fast spawn failure fires `error` with no listener attached, which
   * Node turns into an uncaught exception rather than a rejection the caller
   * can catch. That is worse than failing silently — there is no catch block
   * anywhere that can stop it. The `await` below is the whole test. */
  it("rejects catchably when the process fails before the caller starts consuming", async () => {
    const tap = startAudioTap({ device: "TestDevice", ffmpegPath: "/nonexistent/ffmpeg" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(async () => {
      for await (const _ of tap.frames) void _;
    }).rejects.toThrow(/nonexistent/);
    await tap.stop();
  });

  it("names the device it failed on", async () => {
    const bin = await fakeFfmpeg(`process.stderr.write("Unknown input device"); process.exit(1);`);
    const tap = startAudioTap({ device: "MissingDevice", ffmpegPath: bin });
    await expect(async () => {
      for await (const _ of tap.frames) void _;
    }).rejects.toThrow(/MissingDevice/);
  });

  /** stderr accumulated for the process lifetime, unread until the exit. A
   * capture that is failing rather than dead logs for the whole meeting, so
   * the diagnostic buffer outgrew the audio it described. Keeping the END is
   * the half that matters: the lines nearest the exit are the ones that
   * explain it. */
  it("keeps the most recent stderr and discards the rest", async () => {
    const bin = await fakeFfmpeg(
      `process.stderr.write("HEAD_MARKER" + "x".repeat(40000) + "TAIL_MARKER"); process.exit(1);`
    );
    const tap = startAudioTap({ device: "MissingDevice", ffmpegPath: bin });
    let message = "";
    try {
      for await (const _ of tap.frames) void _;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("TAIL_MARKER");
    expect(message).not.toContain("HEAD_MARKER");
    // The whole message, not just the retained stderr: bounding the buffer is
    // worth nothing if the wrapper around it is unbounded.
    expect(message.length).toBeLessThan(9000);
  });

  /** A stream-level fault on the child's stdout — the pipe breaking
   * mid-capture — is the one failure path a fake binary on disk cannot
   * produce, which is why it was the one whose message nobody noticed was
   * the raw "EPIPE" rather than one naming the device. On a host capturing
   * more than one device, which device died IS the diagnostic. */
  it("names the device when the stream itself fails mid-capture", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => true });
    // `typeof spawn` is a set of overloads; a single-signature stub satisfies
    // none of them structurally. The cast is in the TEST rather than the
    // production type, which keeps the seam typed as the real thing.
    const spawnImpl = (() => child) as unknown as typeof spawn;

    const tap = startAudioTap({ device: "BrokenDevice" }, { spawnImpl });
    const consumed = (async () => {
      for await (const _ of tap.frames) void _;
    })();

    stdout.destroy(new Error("EPIPE"));
    await expect(consumed).rejects.toThrow(/BrokenDevice/);
  });

  /** The end of every normal meeting, and the one shape no other test here
   * produces: they all let the process exit on its own, and none of them
   * calls `stop()` while frames are still flowing.
   *
   * The fake below is written to behave like the real binary rather than like
   * a convenient one — measured on this host, ffmpeg SIGTERMed 700 ms into a
   * capture closes with `{ code: 255, signal: null }`, because it handles the
   * signal and exits through its own teardown. A fake that exits 0, or that
   * dies from the signal, would pass whatever this file asserted and prove
   * nothing about the path that runs in production. */
  it("treats a stop WE asked for as a clean end of capture, not a failure", async () => {
    const bin = await fakeFfmpeg(SIGTERM_HANDLING_CAPTURE);
    const tap = startAudioTap({ device: "TestDevice", ffmpegPath: bin });

    const frames: Buffer[] = [];
    // No try/catch: a throw out of this loop IS the failure under test. It is
    // what used to happen on every normally-ended meeting, and it took the
    // transcriber's flush and the whole transcript with it.
    for await (const frame of tap.frames) {
      frames.push(frame);
      if (frames.length === 1) await tap.stop();
    }

    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.concat(frames).length).toBeGreaterThanOrEqual(640);
  });

  /** Killing the capture is what closes its stdout, so the teardown is
   * allowed to break its own pipe. Reachable only through the injected spawn:
   * a real SIGTERMed ffmpeg ends the stream cleanly, and this is the shape
   * where it does not. */
  it("does not report a broken pipe as a lost meeting once a stop has been asked for", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => true });
    const spawnImpl = (() => child) as unknown as typeof spawn;

    const tap = startAudioTap({ device: "BrokenDevice" }, { spawnImpl });
    const consumed = (async () => {
      for await (const _ of tap.frames) void _;
    })();

    await tap.stop();
    stdout.destroy(new Error("EPIPE"));
    child.emit("close", 255);

    await expect(consumed).resolves.toBeUndefined();
  });

  /** `stop()` sent SIGTERM and resolved in the same breath — a promise about
   * the SIGNAL, not about the process. The caller then wrote the meeting's
   * record while ffmpeg was still capturing all system audio. */
  it("does not resolve until the capture process is actually gone", async () => {
    // A capture that takes a measurable moment over its own teardown. Against
    // a fake that dies in the same millisecond as the signal, a stop() that
    // merely SENT the signal and returned is indistinguishable from one that
    // waited.
    const bin = await fakeFfmpeg(SIGTERM_SLOW_EXIT_CAPTURE);
    const tap = startAudioTap({ device: "TestDevice", ffmpegPath: bin });
    // Let it get as far as producing frames, so there is a live process to
    // stop rather than one still starting.
    for await (const _ of tap.frames) {
      void _;
      break;
    }
    const started = Date.now();
    await tap.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_EXIT_MS);
    // Asked of the operating system, not of the tap: the process was gone
    // BEFORE stop() came back, which is the whole claim.
    expect(await stillRunning(bin)).toBe(false);
  });

  /** A device that will not release is exactly the case SIGTERM cannot fix,
   * and it was the case that got nothing stronger: the capture outlived the
   * run that started it, still holding the device. */
  it("escalates to SIGKILL when the capture ignores SIGTERM", async () => {
    const bin = await fakeFfmpeg(SIGTERM_IGNORING_CAPTURE);
    const tap = startAudioTap({ device: "TestDevice", ffmpegPath: bin });
    for await (const _ of tap.frames) {
      void _;
      break;
    }
    const started = Date.now();
    await tap.stop();
    expect(await stillRunning(bin)).toBe(false);
    // It waited for the polite exit first, then escalated — rather than
    // reaching for SIGKILL immediately, which would deny a healthy capture
    // its own teardown.
    expect(Date.now() - started).toBeGreaterThanOrEqual(STOP_SIGTERM_GRACE_MS);
    expect(Date.now() - started).toBeLessThan(STOP_SIGTERM_GRACE_MS + STOP_SIGKILL_GRACE_MS);
  });

  it("returns at once when there was never a process to stop", async () => {
    // A spawn that failed emits no `close`, so a stop that waited for one
    // would hold its caller for the whole escalation and then report a
    // process that never existed.
    const tap = startAudioTap({ device: "TestDevice", ffmpegPath: "/nonexistent/ffmpeg" });
    const started = Date.now();
    await expect(tap.stop()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(STOP_SIGTERM_GRACE_MS);
    await expect(async () => {
      for await (const _ of tap.frames) void _;
    }).rejects.toThrow(/nonexistent/);
  });
});

/** Whether any process is still running the fake capture at `binPath`.
 *
 * Asked of the OPERATING SYSTEM rather than of the tap, because the tap is
 * what is under test: a `stop()` that resolved without ending anything would
 * answer this question wrongly if the tap were its own witness. */
async function stillRunning(binPath: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise<boolean>((resolve) => {
    execFile("/bin/ps", ["-Ao", "args="], (_error, stdout) => {
      resolve(stdout.split("\n").some((line) => line.includes(binPath)));
    });
  });
}

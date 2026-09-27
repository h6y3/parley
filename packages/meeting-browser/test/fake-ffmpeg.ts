import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stand-in for the capture binary, on disk and executable.
 *
 * Shared rather than copied into each test file: three suites now need a REAL
 * child process — the tap's own tests, the composition's, and the end-to-end
 * meeting — and a fake capture that drifts between them would let one of them
 * assert against a process that behaves like nothing that ships. */
export async function fakeFfmpeg(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));
  const path = join(dir, "fake-ffmpeg");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** How long `SIGTERM_SLOW_EXIT_CAPTURE` takes to finish its own teardown. Long
 * enough that a `stop()` which merely sent the signal and returned would come
 * back while the process is demonstrably still running — which is the defect,
 * and is otherwise invisible against a fake that dies in the same
 * millisecond. A real ffmpeg does run its own teardown; this only makes the
 * window big enough to observe. */
export const SLOW_EXIT_MS = 400;

/** A capture that handles SIGTERM and takes `SLOW_EXIT_MS` to go. */
export const SIGTERM_SLOW_EXIT_CAPTURE = [
  `process.on("SIGTERM", () => setTimeout(() => process.exit(255), ${SLOW_EXIT_MS}));`,
  `setInterval(() => process.stdout.write(Buffer.alloc(640, 7)), 5);`
].join("\n");

/** A capture that IGNORES SIGTERM and keeps writing — a device that will not
 * release, which is the state `stop()`'s escalation to SIGKILL exists for.
 * Nothing weaker will end it, so a test that uses this fake is a test of the
 * escalation itself rather than of the polite path. */
export const SIGTERM_IGNORING_CAPTURE = [
  `process.on("SIGTERM", () => {});`,
  `setInterval(() => process.stdout.write(Buffer.alloc(640, 7)), 5);`
].join("\n");

/** A capture that behaves like the real one does under a deliberate stop: it
 * writes frames continuously, HANDLES SIGTERM, and exits nonzero rather than
 * dying from the signal.
 *
 * Measured against the real ffmpeg on this host — a capture SIGTERMed 700 ms
 * in closes with `{ code: 255, signal: null }`. Every fake that exits 0, or
 * that lets the signal kill it, passes whatever a test asserts and proves
 * nothing about the path that runs in production; that is precisely how a
 * defect on every normally-ended meeting survived a green suite. */
export const SIGTERM_HANDLING_CAPTURE = [
  `process.on("SIGTERM", () => process.exit(255));`,
  `setInterval(() => process.stdout.write(Buffer.alloc(640, 7)), 5);`
].join("\n");

import { spawn } from "node:child_process";

/** How long a post-call hook is given before it is killed.
 *
 * There was no bound at all: a hook that hung hung the whole run, on an
 * unattended host, with the meeting's tab still in the meeting. Two minutes is
 * generous for what this hook is for — it is handed a records path and a
 * meeting id, and anything long-running belongs behind its own queue rather
 * than on the end of a browser session's teardown. */
export const DEFAULT_POST_CALL_TIMEOUT_MS = 120_000;

export interface DispatchPostCallOptions {
  /** Usually the deployment's post-call hook env var, resolved by whoever
   * constructs these options — this module never reads the environment
   * itself. Undefined is a valid deployment: the artifacts are still
   * written, nothing consumes them, and that is not an error. */
  command: string | undefined;
  recordsPath: string;
  meetingId: string;
  /** Defaults to `DEFAULT_POST_CALL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Hand a finished meeting to the configured post-call hook.
 *
 * Same flags the telephony transport's hook already receives
 * (`runPostCallCommand`, `@parley/cli`'s `commands.ts`) — `--records-path`
 * then `--call-id` — so one consumer serves both transports without
 * branching on which produced the record.
 *
 * Returns the hook's exit code, or `null` when no hook is configured. Unlike
 * `runPostCallCommand`, this does NOT detach or ignore stdio, and it does
 * not return before the child does: both a nonzero exit and a failure to
 * spawn are surfaced rather than swallowed. The telephony transport once
 * shipped a hook that could not execute at all in production — it exited
 * 127 and reported nothing anywhere, because that fire-and-forget dispatch
 * never observed either the exit code or the process's `error` event. The
 * failure was found only by placing a real call weeks later.
 *
 * BOUNDED. A hook that never returns used to hang the whole run — on an
 * unattended host, with the meeting's tab still open — and that is the one
 * failure this dispatcher could not report, because reporting happens after
 * the wait. On timeout the child is SIGKILLed and the timeout is thrown,
 * matching `preflight.ts`, which already kills its own child outright rather
 * than asking a process that has stopped answering to please stop. SIGTERM
 * first would only add a second unbounded wait for a hook that has already
 * had its whole budget.
 */
export async function dispatchPostCall(opts: DispatchPostCallOptions): Promise<number | null> {
  if (!opts.command) return null;
  const command = opts.command;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_POST_CALL_TIMEOUT_MS;
  const args = ["--records-path", opts.recordsPath, "--call-id", opts.meetingId];
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    // Cleared on EVERY settle, not just the happy one: an armed timer on a
    // hook that already exited holds the event loop open for the rest of its
    // budget, which is the same "records the meeting and then never exits"
    // failure the session's own loops were fixed for.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `post-call hook ${command} did not finish within ${timeoutMs}ms and was killed. The ` +
            `meeting's record and transcript were already written before it ran.`
        )
      );
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`post-call hook ${command} could not run: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

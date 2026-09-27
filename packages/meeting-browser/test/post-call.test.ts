import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchPostCall } from "../src/post-call.js";

async function fakeCommand(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pc-"));
  const path = join(dir, "fake-post-call");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("dispatchPostCall", () => {
  it("passes the records path and the meeting id, in the flags the hook expects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-"));
    const out = join(dir, "argv.json");
    const cmd = await fakeCommand(
      `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`
    );
    const code = await dispatchPostCall({
      command: cmd,
      recordsPath: "/tmp/records.jsonl",
      meetingId: "MTG123"
    });
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual([
      "--records-path",
      "/tmp/records.jsonl",
      "--call-id",
      "MTG123"
    ]);
  });

  it("returns null, and does not throw, when no hook is configured", async () => {
    // An unconfigured hook is a valid deployment, not an error: the transport
    // still wrote its artifacts.
    expect(
      await dispatchPostCall({ command: undefined, recordsPath: "/x", meetingId: "MTG1" })
    ).toBeNull();
  });

  it("reports a nonzero exit rather than swallowing it", async () => {
    // The telephony transport shipped a delivery command that could not run at
    // all in production, failed with exit 127, and reported nothing anywhere
    // for weeks. A dispatcher that discards the exit code repeats that exactly.
    const cmd = await fakeCommand(`process.exit(3);`);
    expect(await dispatchPostCall({ command: cmd, recordsPath: "/x", meetingId: "MTG1" })).toBe(3);
  });

  it("kills a hook that hangs, rather than hanging the run behind it", async () => {
    // There was no bound at all. A hook that never returns hung the whole
    // run — on an unattended host, with the meeting's tab still in the
    // meeting — and it is the one failure this dispatcher could not report,
    // because reporting happens after the wait.
    const dir = await mkdtemp(join(tmpdir(), "pc-"));
    const pidPath = join(dir, "pid");
    const cmd = await fakeCommand(
      `require("fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));` +
        `setInterval(() => {}, 1000);`
    );
    const started = Date.now();
    await expect(
      dispatchPostCall({
        command: cmd,
        recordsPath: "/x",
        meetingId: "MTG1",
        timeoutMs: 1500
      })
    ).rejects.toThrow(/did not finish within 1500ms and was killed/);
    // It gave up on its own schedule rather than on the hook's.
    expect(Date.now() - started).toBeLessThan(5000);

    // And the hook is actually GONE. Rejecting while leaving it running would
    // report the timeout and still hand the host a process nobody owns —
    // which is the runaway this bound exists to stop, not a smaller version
    // of it.
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    for (let attempt = 0; ; attempt++) {
      // `kill(pid, 0)` sends no signal and only asks whether the process is
      // still there. Polled rather than checked once: SIGKILL is delivered by
      // the kernel and reaped by this process, neither of which is
      // synchronous with the rejection above.
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      expect(attempt).toBeLessThan(100);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it("leaves no timer armed behind a hook that finished in time", async () => {
    // An armed timer on a hook that already exited holds the event loop open
    // for the rest of its budget — the same "records the meeting and then
    // never exits" failure the session's own loops were fixed for. The
    // default budget is two minutes, so an uncleared timer is a two-minute
    // hang after every successful meeting.
    //
    // Fake timers only so the count is inspectable; the child process and its
    // exit are real, and neither is a timer.
    const cmd = await fakeCommand(`process.exit(0);`);
    vi.useFakeTimers();
    try {
      expect(
        await dispatchPostCall({
          command: cmd,
          recordsPath: "/x",
          meetingId: "MTG1",
          timeoutMs: 60_000
        })
      ).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a spawn failure as an exception naming the command", async () => {
    await expect(
      dispatchPostCall({
        command: "/nonexistent/hook",
        recordsPath: "/x",
        meetingId: "MTG1"
      })
    ).rejects.toThrow(/nonexistent\/hook/);
  });
});

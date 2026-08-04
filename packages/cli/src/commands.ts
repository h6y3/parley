import { readFileSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export interface CallArgs {
  to?: string;
  briefPath?: string;
  daemonUrl: string;
}

export interface CallDeps {
  readFile?: (path: string) => string;
  fetchImpl?: typeof fetch;
}

export interface PostCallCommandArgs {
  command?: string;
  recordsPath?: string;
  callId: string;
}

export interface PostCallCommandDeps {
  spawnImpl?: typeof nodeSpawn;
}

/** The shape the CLI expects the `--brief <path>` file to contain: a full
 * `{ version, brief, policy }` envelope (policy composition is now request-time
 * in the server — see @parley/policy). The CLI only reads `brief.to` for the
 * `--to` mismatch guard; it does not otherwise validate the envelope — the
 * server does that via `parseCallEnvelope`. */
interface CallEnvelopeFile {
  version: number;
  brief: { to: string; persona: string; objective: string; facts: readonly string[] };
  policy: unknown;
}

/** POST an envelope file to a running daemon's /call (design decision §2.2: the
 * CLI is a thin HTTP client, not an embedded server). */
export async function runCall(args: CallArgs, deps: CallDeps): Promise<string> {
  if (!args.briefPath) throw new Error("call requires --brief <path>");
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const envelope = JSON.parse(readFile(args.briefPath)) as CallEnvelopeFile;
  if (args.to && args.to !== envelope.brief.to) {
    throw new Error(`--to ${args.to} does not match the brief recipient ${envelope.brief.to}`);
  }
  const res = await fetchImpl(`${args.daemonUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope)
  });
  const json = (await res.json()) as { callId?: string; error?: string };
  if (!res.ok || !json.callId) throw new Error(`call failed (${res.status}): ${json.error ?? "unknown"}`);
  return `call queued: ${json.callId}`;
}

/** Parse the PARLEY_CALLABLE_NUMBERS env var (comma-separated E.164 numbers)
 * into a clean list. Unset/empty → [] (the server's allowlist then fails
 * closed, denying all calls). */
export function parseCallableNumbers(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Fire-and-forget post-call processing hook. The command receives only a
 * records file path and call id; it reads the call record itself, keeping Parley
 * free of any agent-framework or messaging dependency. */
export function runPostCallCommand(args: PostCallCommandArgs, deps: PostCallCommandDeps): boolean {
  if (!args.command || !args.recordsPath) return false;
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  const child = spawnImpl(args.command, ["--records-path", args.recordsPath, "--call-id", args.callId], {
    detached: true,
    stdio: "ignore"
  }) as ChildProcess;
  child.unref();
  return true;
}

const SECRET_KEYS = ["GEMINI_API_KEY", "TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_FROM_NUMBER"] as const;

/** Presence-only diagnostics — never prints a secret value (Global Constraint:
 * secrets never a log line). */
export function runDoctor(deps: { env: Record<string, string | undefined> }): string {
  return SECRET_KEYS.map((k) => `${k}: ${deps.env[k] ? "present" : "MISSING"}`).join("\n");
}

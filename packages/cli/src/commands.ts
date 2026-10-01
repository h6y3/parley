import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { EndReason, TranscriptEvent, TranscriptGap } from "@parley/core";
import type { CompletedCallRecord } from "@parley/server";
import { buildMeetingRecord, type MeetingRecord } from "./meeting-record.js";
import {
  transcriptJsonlPath,
  writeTranscriptJsonl,
  type TranscriptHeader
} from "./transcript-writer.js";

export interface CallArgs {
  to?: string;
  briefPath?: string;
  daemonUrl: string;
  /** Shared secret the daemon requires on POST /call. Absent sends the request
   * unauthenticated, and the daemon answers 401 — surfaced as an ordinary call
   * failure, never retried without it. */
  callToken?: string;
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
    headers: {
      "content-type": "application/json",
      ...(args.callToken ? { authorization: `Bearer ${args.callToken}` } : {})
    },
    body: JSON.stringify(envelope)
  });
  const json = (await res.json()) as { callId?: string; error?: string };
  if (!res.ok || !json.callId)
    throw new Error(`call failed (${res.status}): ${json.error ?? "unknown"}`);
  return `call queued: ${json.callId}`;
}

/** Parse the PARLEY_CALLABLE_NUMBERS env var (comma-separated E.164 numbers)
 * into a clean list. Unset/empty → [] (the server's allowlist then fails
 * closed, denying all calls). */
export function parseCallableNumbers(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Fire-and-forget post-call processing hook. The command receives only a
 * records file path and call id; it reads the call record itself, keeping Parley
 * free of any agent-framework or messaging dependency. */
export function runPostCallCommand(args: PostCallCommandArgs, deps: PostCallCommandDeps): boolean {
  if (!args.command || !args.recordsPath) return false;
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  const child = spawnImpl(
    args.command,
    ["--records-path", args.recordsPath, "--call-id", args.callId],
    {
      detached: true,
      stdio: "ignore"
    }
  ) as ChildProcess;
  child.unref();
  return true;
}

export interface MeetingPostCallArgs {
  /** Where `writeTranscriptJsonl` creates `transcript.jsonl`. */
  transcriptDir: string;
  header: TranscriptHeader;
  events: readonly TranscriptEvent[];
  gaps: readonly TranscriptGap[];
  /** Everything `buildMeetingRecord` needs except `transcriptPath` — this
   * function fills that in from the path the transcript write actually
   * produced, never a guessed one. Written for the "notes were taken"
   * shape (consent granted, transcript exists) — `status` must be
   * `"completed"`. A meeting that never obtained consent has no transcript
   * to write in the first place (CallSession never lets pre-consent audio
   * reach a sink) — that case is `runMeetingPostCallWithoutConsent` below. */
  record: Omit<Parameters<typeof buildMeetingRecord>[0], "transcriptPath">;
  command?: string;
  recordsPath?: string;
}

export interface MeetingPostCallDeps extends PostCallCommandDeps {
  writeTranscript?: typeof writeTranscriptJsonl;
  appendFileImpl?: typeof appendFile;
}

/** The meeting counterpart of `runPostCallCommand`, and the only place the
 * two files that cross the repo boundary — transcript.jsonl and the meeting
 * record — are sequenced together.
 *
 * Build and VALIDATE the record first (no disk I/O — `buildMeetingRecord`
 * throws on input its schema refuses), THEN write the transcript, THEN
 * append the record, THEN spawn the hook — and await both writes before
 * spawning anything. Validating before either file reaches disk means a
 * refused input never leaves a transcript with no record naming it. A2 (the
 * separate repository that reads these files) is invoked with a path to a
 * transcript that must already exist and be complete; spawning first is a
 * race whose loser is a readout built on a truncated transcript. */
export async function runMeetingPostCall(
  args: MeetingPostCallArgs,
  deps: MeetingPostCallDeps
): Promise<boolean> {
  const writeTranscript = deps.writeTranscript ?? writeTranscriptJsonl;
  const appendFileImpl = deps.appendFileImpl ?? appendFile;

  // The record is built and VALIDATED before the transcript reaches disk —
  // mirrors artifacts.ts's identical restructuring and rationale. This used
  // to write the transcript first; `buildMeetingRecord` throws on input its
  // schema refuses, so a bad input left a transcript on disk with no record
  // ever written for it. The path is resolved from `transcriptJsonlPath`
  // rather than predicted, so the name the record carries and the name the
  // writer uses are one expression and cannot drift apart.
  const transcriptPath = transcriptJsonlPath(args.transcriptDir);
  const record: MeetingRecord = buildMeetingRecord({ ...args.record, transcriptPath });

  const written = await writeTranscript(args.transcriptDir, args.header, args.events, args.gaps);
  if (written !== transcriptPath) {
    // Unreachable while both sides call `transcriptJsonlPath`. If it ever
    // becomes reachable, the record already names a file that is not the
    // one on disk, and appending it would publish that lie — so fail here
    // instead, loudly, with both paths.
    throw new Error(`transcript written to ${written} but the record names ${transcriptPath}`);
  }

  if (args.recordsPath) {
    // Mirrors the production (non-meeting) path's `mkdirSync` guard — without
    // it, a missing records directory throws AFTER the transcript is already
    // on disk and BEFORE the hook spawns, leaving a transcript with no record
    // and no hook: a defect Important-cheap-fix caught with no test covering
    // the directory-doesn't-exist-yet case, which is exactly why it survived.
    await mkdir(dirname(args.recordsPath), { recursive: true });
    await appendFileImpl(args.recordsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  return runPostCallCommand(
    { command: args.command, recordsPath: args.recordsPath, callId: record.callId },
    deps
  );
}

export interface MeetingPostCallWithoutConsentArgs {
  /** Everything `buildMeetingRecord` needs except `transcriptPath` and
   * `consentReceipt`, both forced to `null` here. `status` must NOT be
   * `"completed"` — `buildMeetingRecord`'s own schema throws if it is,
   * since `"completed"` requires a receipt this path by definition doesn't
   * have. */
  record: Omit<
    Parameters<typeof buildMeetingRecord>[0],
    "transcriptPath" | "consentReceipt" | "status"
  > & { status: "consent_refused" | "consent_timeout" | "failed" | "never_joined" };
  command?: string;
  recordsPath?: string;
}

/** The other meeting counterpart of `runPostCallCommand`: a meeting that
 * never obtained consent, so nothing was recorded — no `transcript.jsonl` is
 * written at all. This is the case where the promise made aloud to the room
 * ("I will not take notes until you say go ahead") was kept, and the record
 * is how anyone downstream learns THAT happened rather than nothing
 * happening: without a `kind: "meeting"` record here, a global post-call
 * hook has no way to distinguish "this was a meeting and consent was
 * refused" from "this was never a meeting at all". */
export async function runMeetingPostCallWithoutConsent(
  args: MeetingPostCallWithoutConsentArgs,
  deps: PostCallCommandDeps & { appendFileImpl?: typeof appendFile }
): Promise<boolean> {
  const appendFileImpl = deps.appendFileImpl ?? appendFile;
  const record: MeetingRecord = buildMeetingRecord({
    ...args.record,
    transcriptPath: null,
    consentReceipt: null
  });
  if (args.recordsPath) {
    await mkdir(dirname(args.recordsPath), { recursive: true });
    await appendFileImpl(args.recordsPath, `${JSON.stringify(record)}\n`, "utf8");
  }
  return runPostCallCommand(
    { command: args.command, recordsPath: args.recordsPath, callId: record.callId },
    deps
  );
}

/** `EndReason` (`@parley/core`, 9 values covering any call, meeting or not)
 * has no 1:1 mapping onto `MeetingRecord`'s `status` (5 values, as of the
 * `never_joined` addition below) or `endedReason` (4 different values) —
 * both were fixed by Task 13's original brief, and widening `endedReason`
 * further is out of scope for this fix (see the Task 13 review's Important 3
 * discussion of the schema's own limits). `endedReason` is REQUIRED on every
 * record regardless of status, so every `EndReason` needs a bucket rather
 * than being left unmapped:
 *
 * `status`:
 *  - a consent receipt exists                 -> "completed"
 *  - no receipt, endedBy === "error"          -> "failed" (our own teardown
 *    broke — a technical fault, not a consent outcome)
 *  - no receipt, endedBy === "consentTimeout" -> "consent_timeout" (the one
 *    EndReason that names this exactly — and only reachable after the
 *    request was actually made, so it outranks the "never asked" check
 *    below regardless of `modelTurnsCompleted`)
 *  - no receipt, endedBy === "consentDenied"  -> "consent_refused" (the room
 *    said no in so many words. Like the timeout above it outranks the
 *    "never asked" check below regardless of `modelTurnsCompleted`: a denial
 *    can only be raised inside the consent window, which requires the agent to
 *    have spoken, and a turn that has not COMPLETED yet is not evidence it
 *    never asked)
 *  - no receipt, no completed model turn      -> "never_joined" (found on a
 *    real call: a dial-in IVR hung up on us before the agent ever spoke, so
 *    consent was never even requested. Recorded as "we were refused" would
 *    be a false statement about a room's wishes for a room the agent never
 *    reached — the whole reason this bucket exists rather than folding into
 *    the one below)
 *  - no receipt, anything else                -> "consent_refused" (the call
 *    reached the point of asking — at least one model turn completed — and
 *    still ended with no receipt. `CallSession` now distinguishes an explicit
 *    refusal via `consentDenied` above; this remains the catch-all for "asked
 *    and never got a yes" by any other route, and is still not a claim that
 *    anyone said no)
 *
 * `endedReason`:
 *  - durationCap / silenceCap           -> "duration_cap"        (both are
 *    automatic ceiling-triggered endings)
 *  - transcriptionLost                  -> "transcription_lost" (direct)
 *  - remote / model / consentTimeout / consentDenied / error -> "far_end" (the
 *    only non-forced, non-technical bucket available; `status`, not
 *    `endedReason`, is what tells a reader this was a consent failure, an
 *    internal fault, or the agent never joining at all. A denied meeting hangs
 *    up on ITS OWN initiative, so `far_end` is imprecise for it — but widening
 *    `endedReason` is a change to the committed schema A2 reads, and `status`
 *    already carries the fact that matters)
 *
 * There is no `"removed"` bucket, because `EndReason` no longer has a
 * `"removed"` member and no transport Parley has could ever produce one —
 * see the note next to `EndReason` in @parley/core. A host dropping the
 * dial-in reads as `far_end`, which is what the carrier actually reported. */
export function classifyMeetingOutcome(
  endedBy: EndReason,
  hasConsentReceipt: boolean,
  modelTurnsCompleted: number
): { status: MeetingRecord["status"]; endedReason: MeetingRecord["endedReason"] } {
  const endedReason: MeetingRecord["endedReason"] =
    endedBy === "durationCap" || endedBy === "silenceCap"
      ? "duration_cap"
      : endedBy === "transcriptionLost"
        ? "transcription_lost"
        : "far_end";

  if (hasConsentReceipt) return { status: "completed", endedReason };
  if (endedBy === "error") return { status: "failed", endedReason };
  if (endedBy === "consentTimeout") return { status: "consent_timeout", endedReason };
  if (endedBy === "consentDenied") return { status: "consent_refused", endedReason };
  if (modelTurnsCompleted === 0) return { status: "never_joined", endedReason };
  return { status: "consent_refused", endedReason };
}

export interface CompletedCallPostCallArgs {
  record: CompletedCallRecord;
  /** Root of the meetings tree — never written to directly. One meeting's
   * artifacts land in `<meetingsDir>/<UTC date>/<callId>/`; see
   * `meetingTranscriptDir`. */
  meetingsDir: string;
  recordsPath?: string;
  command?: string;
}

/** Where one meeting's `transcript.jsonl` goes:
 * `<meetingsDir>/<YYYY-MM-DD>/<callId>/`.
 *
 * DATE-PARTITIONED, and that is the load-bearing part rather than a tidiness
 * preference. The consumer of these files (a separate repository) runs a
 * retention sweep, and a sweeper needs something to select on that it can read
 * from the path alone — a flat `transcripts/<callId>/` tree forces it to open
 * and parse every meeting it has ever recorded to find out which ones are old.
 *
 * The date is the UTC date of the meeting's `startedAt`, so it is derived from
 * the record rather than from whatever the clock says when the file is being
 * written — a meeting that runs across midnight files under the day it began,
 * on every host, in every timezone. `startedAt` is an ISO-8601 UTC instant, so
 * the first ten characters are that date.
 *
 * The ROOT is the configured records directory, not a hard-coded
 * `~/.config/parley`: a library must not decide where a deployment keeps its
 * data. With the documented default (`PARLEY_CALL_RECORDS_PATH` under
 * `~/.config/parley/`) this resolves to exactly the specified
 * `~/.config/parley/meetings/<date>/<callId>/`. */
export function meetingTranscriptDir(
  meetingsDir: string,
  startedAt: string,
  callId: string
): string {
  return join(meetingsDir, startedAt.slice(0, 10), callId);
}

async function runOrdinaryPostCall(
  record: CompletedCallRecord,
  args: { recordsPath?: string; command?: string },
  deps: PostCallCommandDeps & { appendFileImpl?: typeof appendFile }
): Promise<void> {
  if (args.recordsPath) {
    const appendFileImpl = deps.appendFileImpl ?? appendFile;
    await mkdir(dirname(args.recordsPath), { recursive: true });
    await appendFileImpl(args.recordsPath, `${JSON.stringify(record)}\n`, "utf8");
  }
  runPostCallCommand(
    { command: args.command, recordsPath: args.recordsPath, callId: record.callId },
    deps
  );
}

/** The single entry point `cli.ts`'s `onCallCompleted` calls: everything
 * about turning one finished call — meeting or not, consented or not — into
 * the right on-disk artifact(s) and (if configured) the spawned hook, in the
 * right order. Kept out of `cli.ts` so it is unit-testable without a live
 * daemon (`cli.ts`'s `serve()` wires concrete Twilio/Gemini providers from
 * required env vars and cannot be exercised in a unit test). */
export async function runCompletedCallPostCall(
  args: CompletedCallPostCallArgs,
  deps: MeetingPostCallDeps
): Promise<void> {
  const { record } = args;
  if (!record.isMeeting) {
    await runOrdinaryPostCall(record, args, deps);
    return;
  }

  const durationSeconds = Math.max(
    0,
    (Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000
  );
  const { status, endedReason } = classifyMeetingOutcome(
    record.endedBy,
    record.consentReceipt !== undefined,
    record.modelTurnsCompleted
  );
  const base = {
    callId: record.callId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationSeconds,
    endedReason,
    // Passed through verbatim from `CompletedCallRecord.brief`, itself
    // `CallSession.meetingBrief` (@parley/core) read from the call's own
    // execution.meeting.brief — never derived from anything else on this
    // record. When the caller supplied none, `record.brief` is `undefined`
    // and `buildMeetingRecord`'s schema (@parley/cli's meeting-record.ts)
    // omits the key entirely rather than stamping placeholder strings.
    brief: record.brief,
    gapMs: record.gapMs,
    coveredMs: record.coveredMs,
    // Meetings are precisely the calls that press digits to join a bridge
    // (MEETING_MAX_PRESSES = 40 vs CALL_MAX_PRESSES = 20 for an ordinary
    // call) — passed through verbatim so they are not silently discarded
    // the way they were before this fix, when only `runOrdinaryPostCall`'s
    // raw CompletedCallRecord carried them.
    answeredBy: record.answeredBy,
    outcome: record.outcome,
    dtmf: record.dtmf,
    // The number `status` was just classified from, above — written to the
    // artifact so a reader can verify the classification independently
    // rather than trust it. Previously computed correctly and then
    // discarded: it drove `classifyMeetingOutcome` but was never part of
    // `base`, so it never reached this object at all (see
    // meeting-record.ts's doc on the field).
    modelTurnsCompleted: record.modelTurnsCompleted,
    // What the speaking plane ran on and how soon it first spoke — the two
    // facts a provider A/B compares. Passed through verbatim, like everything
    // above; `firstModelAudioMs` stays absent when the model never spoke.
    realtime: record.realtime,
    ...(record.firstModelAudioMs !== undefined
      ? { firstModelAudioMs: record.firstModelAudioMs }
      : {}),
    // Present only when the realtime session closed unasked (credits, quota).
    ...(record.realtimeClose ? { realtimeClose: record.realtimeClose } : {})
  };

  if (status === "completed") {
    if (!record.consentReceipt) {
      // Cannot happen: `classifyMeetingOutcome` only returns "completed" when
      // `hasConsentReceipt` was true, computed from this exact check just
      // above. Guard kept because TS cannot verify that cross-function
      // invariant, and silently falling through to the no-transcript path
      // would be worse than a loud failure — it would emit a
      // "consent_refused"-shaped record for a call CallSession says
      // currently HAS a receipt.
      throw new Error(
        `runCompletedCallPostCall: status is "completed" but no consentReceipt for call ${record.callId}`
      );
    }
    // `ConsentReceipt.utterances` (core) is a READONLY array of
    // `{ speaker: SpeakerRole; ... }`; `meetingRecordSchema`'s shape wants a
    // plain mutable array of `{ speaker: string; ... }` — reshape rather
    // than assign directly.
    const consentReceipt = {
      requestedAt: record.consentReceipt.requestedAt,
      grantedAt: record.consentReceipt.grantedAt,
      phrase: record.consentReceipt.phrase,
      matchedPhrase: record.consentReceipt.matchedPhrase,
      utterances: record.consentReceipt.utterances.map((u) => ({
        speaker: u.speaker,
        text: u.text
      }))
    };
    await runMeetingPostCall(
      {
        transcriptDir: meetingTranscriptDir(args.meetingsDir, record.startedAt, record.callId),
        header: { callId: record.callId, startedAt: record.startedAt, diarized: false },
        events: record.transcript,
        gaps: record.gaps,
        record: { ...base, status: "completed", consentReceipt },
        command: args.command,
        recordsPath: args.recordsPath
      },
      deps
    );
    return;
  }

  await runMeetingPostCallWithoutConsent(
    {
      record: { ...base, status },
      command: args.command,
      recordsPath: args.recordsPath
    },
    deps
  );
}

const SECRET_KEYS = [
  "GEMINI_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_FROM_NUMBER",
  "PARLEY_CALL_TOKEN"
] as const;

/** Everything a meeting needs, and the reason `DEEPGRAM_API_KEY` is NOT in
 * `SECRET_KEYS` above.
 *
 * Meetings are a capability a deployment either wants or does not, so their
 * configuration is reported as a capability rather than as five separate
 * presence lines that read like faults. Listing `DEEPGRAM_API_KEY` alongside
 * the boot-required secrets printed `MISSING` on a Gemini-only deployment that
 * never intended to take a meeting, exactly as it would on one that meant to
 * and forgot — the check could not tell those two states apart, and every
 * `MISSING` line then has to be triaged by hand.
 *
 * Both halves, because the two fail independently and each alone is useless:
 * without the key there is no listening plane (`POST /call` refuses the
 * envelope), and without the records path there is nowhere to write the
 * transcript and the record (`POST /call` refuses it for that too). */
const MEETING_KEYS = ["DEEPGRAM_API_KEY", "PARLEY_CALL_RECORDS_PATH"] as const;

/** Presence-only diagnostics — never prints a secret value (Global Constraint:
 * secrets never a log line). */
export function runDoctor(deps: { env: Record<string, string | undefined> }): string {
  const missing = MEETING_KEYS.filter((k) => !deps.env[k]);
  return [
    ...SECRET_KEYS.map((k) => `${k}: ${deps.env[k] ? "present" : "MISSING"}`),
    missing.length === 0
      ? "meetings: ready"
      : `meetings: not configured (needs ${missing.join(", ")})`
  ].join("\n");
}

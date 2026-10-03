import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { CallEnvelope } from "@parley/policy";
import { campaignStatus, type CampaignDeps, type CampaignState } from "./campaign.js";
import type { Timeline } from "./capture.js";
import {
  buildEnvelope,
  CALL_CEILING_SECONDS,
  type CalleePersona,
  type PhoneScenario,
  type TestConfig
} from "./scenario.js";
import {
  appendSpend,
  callCostUsd,
  deepgramTier,
  type DeepgramTier,
  type RealtimeProvider
} from "./spend.js";
import { voicedMs } from "./timing.js";

/** Per-call ceiling: a call not done this long after dialling is hung up. */
export const RESULT_TIMEOUT_MS = CALL_CEILING_SECONDS * 1000;
/** After a timeout hangup, how long to wait for the sim to write the capture. */
export const HANGUP_WAIT_MS = 30_000;
export const RESULT_POLL_MS = 2_000;
/** How long after done the call record may take to appear (Review Focus 4). */
export const RECORD_WAIT_MS = 30_000;
export const RECORD_POLL_MS = 1_000;
/** A call may start only if this many minutes still fit under the cap. */
export const WORST_CASE_MINUTES = (RESULT_TIMEOUT_MS + HANGUP_WAIT_MS) / 60_000;
/** Any one HTTP request to the daemon or the sim. */
const REQUEST_TIMEOUT_MS = 30_000;

export type CallErrorCode =
  | "sim-unreachable"
  | "persona-missing"
  | "call-timeout"
  | "record-missing"
  | "budget-stop"
  | "dial-refused"
  /** POST /call failed or returned no callId. The persona stays queued on the
   * sim, so the run ends rather than letting the next call take it. */
  | "dial-failed"
  /** A timed-out call the sim could not account for: no done after the
   * hangup, or no CallSid ever reported for the tag. The sim's persona queue
   * is FIFO with no dequeue, so the next call could take a stale persona under
   * the wrong tag and be impossible to hang up. The run ends. */
  | "sim-desync"
  /** The simulated callee never spoke: no transcript and under 1 s voiced on
   * its channel. A failure of the callee's provider, not the agent's; the
   * report excludes the call from every rate. */
  | "callee-silent";

export interface CallResult {
  tag: string;
  scenarioId: string;
  persona: string;
  config: string;
  callId?: string;
  wavPath?: string;
  timelinePath?: string;
  record?: unknown;
  minutes: number;
  usd: number;
  errors: CallErrorCode[];
  /** The sim's own error text for this call, if it reported one. */
  simError?: string;
  /** Set on a call whose callee broke character: it is kept, excluded from
   * every rate, and its cell is rerun once. */
  excludedReason?: "persona-violation";
  /** On that rerun: the tag of the call it replaces. */
  rerunOf?: string;
  /** The persona is diagnostic: the call is reported on its own and never
   * enters a rate, the judge or the decision rule. */
  diagnostic?: true;
}

export interface RunCampaignOptions {
  scenarios: PhoneScenario[];
  configs: TestConfig[];
  callsPerCell: number;
  daemonUrl: string;
  callToken: string;
  simControlUrl: string;
  recordsPath: string;
  deps: CampaignDeps;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a finished call's callee broke character (`persona-violation`).
   * Such a call is rerun once in the same cell, subject to the budget check. */
  isPersonaViolation?: (result: CallResult) => boolean;
}

/** The Deepgram tier an agent configuration is billed at: Standard only for a
 * think model known to be Standard; any other, or none (the daemon's default,
 * unknown here), is Advanced. A Gemini agent has its own rate. */
export function agentTier(config: TestConfig): DeepgramTier {
  return config.realtime.provider === "deepgram" ? deepgramTier(config.realtime.think) : "standard";
}

/** The sim plays the callee on the provider NOT under test. */
function calleeProvider(config: TestConfig): RealtimeProvider {
  return config.realtime.provider === "gemini" ? "deepgram" : "gemini";
}

/** The last line of defence before a billed dial: the envelope must call the
 * active campaign's own number, and nothing else. */
export function assertDialable(envelope: CallEnvelope, state: CampaignState | undefined): void {
  if (!state || state.status !== "active" || !state.number) {
    throw new Error("dial-refused: no active test campaign");
  }
  if (envelope.brief.to !== state.number) {
    throw new Error("dial-refused: the envelope does not dial the campaign's number");
  }
}

interface SimResultBody {
  state: "pending" | "done";
  wavPath?: string;
  timelinePath?: string;
  callSid?: string;
  error?: string;
}

const TAG_UNSAFE = /[^A-Za-z0-9._-]/g;
const slug = (s: string): string => s.replace(TAG_UNSAFE, "-");

/** A tag the sim accepts (letters, digits, . _ -; alphanumeric first; ≤ 128)
 * and has never seen: the random suffix keeps re-runs from colliding. */
function freshTag(s: PhoneScenario, p: CalleePersona, c: TestConfig, n: number): string {
  const suffix = `.${n}-${randomBytes(4).toString("hex")}`;
  const head = `${slug(s.id)}.${slug(p.name)}.${slug(c.name)}`.slice(0, 128 - suffix.length);
  return `${/^[A-Za-z0-9]/.test(head) ? head : `t${head.slice(1)}`}${suffix}`;
}

const toMinutes = (ms: number): number => Math.ceil(Math.max(0, ms) / 6_000) / 10;

/** The call's length from the sim's timeline: its last event. */
function timelineMs(path: string | undefined): number | undefined {
  if (!path) return undefined;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as Partial<Timeline>;
    if (!Array.isArray(t.events)) return undefined;
    const times = t.events
      .map((e) => (e as { atMs?: unknown }).atMs)
      .filter((at): at is number => typeof at === "number" && Number.isFinite(at));
    // No usable time, or none past 0: the caller falls back to the wall clock.
    const last = times.length > 0 ? Math.max(...times) : 0;
    return last > 0 ? last : undefined;
  } catch {
    return undefined;
  }
}

function timelineHas(path: string | undefined, event: string): boolean {
  if (!path) return false;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as Partial<Timeline>;
    return Array.isArray(t.events) && t.events.some((e) => e.event === event);
  } catch {
    return false;
  }
}

/** The record for `callId`, if one has been fully written. Lines that are not
 * JSON — a partially written last line — are skipped. */
function findRecord(path: string, callId: string): unknown {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (typeof v === "object" && v !== null && (v as { callId?: unknown }).callId === callId) {
        return v;
      }
    } catch {
      // half-written or corrupt: not ours yet
    }
  }
  return undefined;
}

/** Below this much voiced callee audio, with no transcript, the callee never
 * spoke. */
export const CALLEE_SILENT_MS = 1000;
/** A call shorter than this is never `callee-silent`. The realistic callee
 * first speaks 1.2 s after the stream opens (instantly, for an instant one),
 * and the capture ends when the stream does, so a call this long gave the
 * callee its chance to speak: a shorter one may be an agent that hung up or
 * dropped before the callee could say anything, which is the agent's failure. */
export const CALLEE_SILENT_MIN_CALL_MS = 5000;

/** Whether the simulated callee never spoke on a captured call that lasted
 * `callMs` (`CALLEE_SILENT_MIN_CALL_MS` or more): its timeline has no
 * transcript and its channel is voiced for under `CALLEE_SILENT_MS`. A call
 * with no readable capture is not judged here (the report already excludes it
 * as `capture-missing`). */
export function calleeSilent(
  wavPath: string | undefined,
  timelinePath: string | undefined,
  callMs: number
): boolean {
  if (!wavPath || !timelinePath || callMs < CALLEE_SILENT_MIN_CALL_MS) return false;
  try {
    const t = JSON.parse(readFileSync(timelinePath, "utf8")) as Partial<Timeline>;
    if (!Array.isArray(t.calleeText)) return false;
    if (t.calleeText.some((line) => typeof line === "string" && line.trim() !== "")) return false;
    return voicedMs(readFileSync(wavPath), "callee") < CALLEE_SILENT_MS;
  } catch {
    return false;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs every scenario × persona × config × `callsPerCell`, one call at a
 * time, against the active campaign's number. Stops the whole run on
 * `budget-stop`, `sim-unreachable`, `dial-refused`, `dial-failed` or
 * `sim-desync`; every
 * other error is recorded and the run goes on. */
export async function runCampaign(opts: RunCampaignOptions): Promise<CallResult[]> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const { deps } = opts;
  const nowMs = (): number => deps.now().getTime();
  const sim = opts.simControlUrl.replace(/\/+$/, "");
  const daemon = opts.daemonUrl.replace(/\/+$/, "");
  const results: CallResult[] = [];

  const request = (url: string, init: RequestInit = {}): Promise<Response> =>
    doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  const getResult = async (tag: string): Promise<SimResultBody | undefined> => {
    try {
      const res = await request(`${sim}/control/result/${tag}`);
      if (!res.ok) return undefined;
      return (await res.json()) as SimResultBody;
    } catch {
      return undefined; // a blip: keep polling until the deadline
    }
  };

  /** The tags of calls the sim answered with no persona queued, or undefined
   * when the sim cannot be asked. */
  const listUnclaimed = async (): Promise<string[] | undefined> => {
    try {
      const res = await request(`${sim}/control/unclaimed`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { tags?: unknown };
      return Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === "string")
        : undefined;
    } catch {
      return undefined;
    }
  };

  for (const scenario of opts.scenarios) {
    for (const persona of scenario.personas) {
      for (const config of opts.configs) {
        for (let n = 1; n <= opts.callsPerCell; n++) {
          // A call whose callee broke character is excluded and its cell rerun
          // once (the data-hygiene rule); a second violation is kept as is.
          let replaces: CallResult | undefined;
          for (let attempt = 1; attempt <= 2; attempt++) {
            const tag = freshTag(scenario, persona, config, n);
            const result: CallResult = {
              tag,
              scenarioId: scenario.id,
              persona: persona.name,
              config: config.name,
              minutes: 0,
              usd: 0,
              errors: [],
              ...(replaces ? { rerunOf: replaces.tag } : {}),
              ...(persona.diagnostic === true ? { diagnostic: true as const } : {})
            };
            results.push(result);
            const stop = (code: CallErrorCode): CallResult[] => {
              result.errors.push(code);
              return results;
            };

            // 1. An active campaign, and room in the budget for the worst case.
            let state: CampaignState | undefined;
            let monthSpend: number;
            try {
              const status = await campaignStatus(deps);
              state = status.state;
              monthSpend = status.monthSpendUsd;
            } catch {
              return stop("dial-refused");
            }
            if (!state || state.status !== "active" || !state.number) return stop("dial-refused");
            const campaignId = state.id;
            const agent = config.realtime.provider;
            const tier = agentTier(config);
            const callee = calleeProvider(config);
            const worst = callCostUsd(WORST_CASE_MINUTES, agent, tier, callee);
            if (monthSpend + worst > deps.budgetUsd) return stop("budget-stop");

            const envelope = buildEnvelope(scenario, state.number, config);
            try {
              assertDialable(envelope, state);
            } catch {
              return stop("dial-refused");
            }

            // 2. Queue the persona on the sim.
            try {
              const res = await request(`${sim}/control/expect`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ persona, tag })
              });
              if (!res.ok) return stop("sim-unreachable");
            } catch {
              return stop("sim-unreachable");
            }
            // Calls the sim filed as unclaimed before this dial are not ours.
            const before = await listUnclaimed();
            if (!before) return stop("sim-unreachable");
            const unclaimedBefore = new Set(before);

            // 3. Dial, re-checking the campaign at the last moment.
            try {
              assertDialable(envelope, (await campaignStatus(deps)).state);
            } catch {
              return stop("dial-refused");
            }
            const dialAt = nowMs();
            let callId: string | undefined;
            let dialAccepted = false;
            /** A call that may have been placed but cannot be followed: try to
             * end it, then book the worst case, since it cannot be measured. */
            const unmeasurable = async (): Promise<CallResult[]> => {
              try {
                await request(`${sim}/control/hangup/${tag}`, { method: "POST" });
              } catch {
                // best-effort; the run ends either way
              }
              result.minutes = WORST_CASE_MINUTES;
              result.usd = worst;
              appendSpend(deps.spendPath, {
                at: deps.now().toISOString(),
                campaign: campaignId,
                callTag: tag,
                minutes: result.minutes,
                usd: result.usd
              });
              return stop("dial-failed");
            };
            try {
              const res = await request(`${daemon}/call`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${opts.callToken}`
                },
                body: JSON.stringify(envelope)
              });
              if (res.ok) {
                // A 2xx means the daemon took the call, with or without an id.
                dialAccepted = true;
                const body = (await res.json().catch(() => ({}))) as { callId?: unknown };
                if (typeof body.callId === "string" && body.callId) callId = body.callId;
              }
            } catch {
              // The daemon may have placed the call before the response was lost.
              return unmeasurable();
            }
            if (dialAccepted && !callId) return unmeasurable();
            if (!callId) return stop("dial-failed");
            result.callId = callId;

            // 4. Wait for the sim to finish the call. Correlation is by tag
            // alone: the sim sees the test number's inbound leg, whose CallSid is
            // not the daemon's callId (the outbound leg), so the two are never
            // compared. A tag that took a call is ours, because calls are serial,
            // the persona is queued before the dial, and the sim rejects every
            // caller but the daemon's number. If the sim answered with no persona
            // queued (it lost the tag), it files the call as unclaimed under
            // persona-missing-<its CallSid>; a new unclaimed entry is this call.
            let track = tag;
            let sawCallSid = false;
            const poll = async (): Promise<SimResultBody | undefined> => {
              const r = await getResult(track);
              if (r?.callSid !== undefined) sawCallSid = true;
              if (r?.state === "done") return r;
              if (track === tag && r?.callSid === undefined) {
                const fresh = (await listUnclaimed())?.find((t) => !unclaimedBefore.has(t));
                if (fresh) {
                  track = fresh;
                  result.errors.push("persona-missing");
                  const m = await getResult(fresh);
                  if (m?.callSid !== undefined) sawCallSid = true;
                  if (m?.state === "done") return m;
                }
              }
              return undefined;
            };
            const pollUntil = async (deadline: number): Promise<SimResultBody | undefined> => {
              for (;;) {
                const r = await poll();
                if (r) return r;
                const left = deadline - nowMs();
                if (left <= 0) return undefined;
                await sleep(Math.min(RESULT_POLL_MS, left));
              }
            };

            let done = await pollUntil(dialAt + RESULT_TIMEOUT_MS);
            let desync = false;
            if (!done) {
              result.errors.push("call-timeout");
              desync = !sawCallSid;
              try {
                await request(`${sim}/control/hangup/${track}`, { method: "POST" });
              } catch {
                // the wait below still bounds this call
              }
              done = await pollUntil(nowMs() + HANGUP_WAIT_MS);
              if (!done) desync = true;
            }
            const doneAt = nowMs();
            if (done?.wavPath) result.wavPath = done.wavPath;
            if (done?.timelinePath) result.timelinePath = done.timelinePath;
            if (done?.error) result.simError = done.error;
            if (
              !result.errors.includes("persona-missing") &&
              timelineHas(result.timelinePath, "persona-missing")
            ) {
              result.errors.push("persona-missing");
            }
            // The call's length: the timeline's, else the wall clock's.
            const callMs = timelineMs(result.timelinePath) ?? doneAt - dialAt;
            if (calleeSilent(result.wavPath, result.timelinePath, callMs)) {
              result.errors.push("callee-silent");
            }

            // 5. Book the spend now, so a crash in the record wait cannot lose it.
            result.minutes = toMinutes(callMs);
            result.usd = callCostUsd(result.minutes, agent, tier, callee);
            appendSpend(deps.spendPath, {
              at: deps.now().toISOString(),
              campaign: campaignId,
              callTag: tag,
              minutes: result.minutes,
              usd: result.usd
            });
            if (desync) return stop("sim-desync");

            // 6. The daemon writes the record after the call ends; give it time.
            const recordDeadline = doneAt + RECORD_WAIT_MS;
            for (;;) {
              const record = findRecord(opts.recordsPath, callId);
              if (record !== undefined) {
                result.record = record;
                break;
              }
              const left = recordDeadline - nowMs();
              if (left <= 0) {
                result.errors.push("record-missing");
                break;
              }
              await sleep(Math.min(RECORD_POLL_MS, left));
            }

            if (attempt === 1 && opts.isPersonaViolation?.(result)) {
              result.excludedReason = "persona-violation";
              replaces = result;
              continue;
            }
            break;
          }
        }
      }
    }
  }
  return results;
}

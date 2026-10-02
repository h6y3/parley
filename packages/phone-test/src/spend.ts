import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Per-minute list prices, USD (design spec §7). Media Streams bills per
 * stream, and a test call carries two: the agent's leg and the callee's. */
export const RATES_USD_PER_MIN = {
  twilioOutbound: 0.014,
  twilioInbound: 0.0085,
  mediaStreams: 0.0044,
  gemini: 0.023,
  deepgramStandard: 0.075,
  deepgramAdvanced: 0.163
} as const;

/** A US local number's monthly fee, USD, charged when it is bought. */
export const NUMBER_MONTHLY_USD = 1.15;

export type RealtimeProvider = "gemini" | "deepgram";
export type DeepgramTier = "standard" | "advanced";

/** The Deepgram think models billed at the Standard tier. Any other model —
 * including none, which runs the daemon's own default, unknown here — is
 * priced at Advanced, so the spend log can only read high. */
export const DEEPGRAM_STANDARD_THINK_MODELS: ReadonlySet<string> = new Set([
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-5.4-mini",
  "claude-haiku-4-5",
  "gemini-3.5-flash"
]);

/** The tier a Deepgram agent thinking with `think` is billed at. */
export function deepgramTier(think: string | undefined): DeepgramTier {
  return think !== undefined && DEEPGRAM_STANDARD_THINK_MODELS.has(think) ? "standard" : "advanced";
}

export interface SpendEntry {
  at: string;
  campaign: string;
  callTag: string;
  minutes: number;
  usd: number;
}

function realtimeRate(provider: RealtimeProvider, tier: DeepgramTier): number {
  if (provider === "gemini") return RATES_USD_PER_MIN.gemini;
  return tier === "advanced"
    ? RATES_USD_PER_MIN.deepgramAdvanced
    : RATES_USD_PER_MIN.deepgramStandard;
}

/** Estimated cost of one test call of `minutes` (already rounded up to 0.1).
 * Twilio bills voice and Media Streams per started minute, so those legs are
 * charged on whole minutes; the realtime models on `minutes` as given.
 * `agentTier` applies to a Deepgram agent only. A Deepgram callee is billed at
 * the Advanced tier: it thinks with the daemon's configured model, which the
 * harness cannot see, so the conservative rate is used. */
export function callCostUsd(
  minutes: number,
  agentProvider: RealtimeProvider,
  agentTier: DeepgramTier,
  calleeProvider: RealtimeProvider
): number {
  const r = RATES_USD_PER_MIN;
  // The epsilon keeps 3.0000000001 (float noise) from billing a fourth minute.
  const twilioMinutes = Math.ceil(Math.max(0, minutes) - 1e-9);
  const twilio = r.twilioOutbound + r.twilioInbound + 2 * r.mediaStreams;
  const realtime =
    realtimeRate(agentProvider, agentTier) + realtimeRate(calleeProvider, "advanced");
  return twilioMinutes * twilio + minutes * realtime;
}

/** Every well-formed entry in the log. A missing log is empty; a corrupt or
 * partial line (a crash mid-append) is skipped rather than fatal. */
function readEntries(logPath: string): SpendEntry[] {
  if (!existsSync(logPath)) return [];
  const out: SpendEntry[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    const e = v as Partial<SpendEntry>;
    if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) continue;
    if (typeof e.usd !== "number" || !Number.isFinite(e.usd) || e.usd < 0) continue;
    out.push(e as SpendEntry);
  }
  return out;
}

/** Spend logged in `now`'s calendar month, UTC. */
export function monthSpendUsd(logPath: string, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let sum = 0;
  for (const e of readEntries(logPath)) {
    const at = new Date(e.at);
    if (at.getUTCFullYear() === y && at.getUTCMonth() === m) sum += e.usd;
  }
  return sum;
}

/** Spend logged against one campaign, across all months. */
export function campaignSpendUsd(logPath: string, campaign: string): number {
  let sum = 0;
  for (const e of readEntries(logPath)) if (e.campaign === campaign) sum += e.usd;
  return sum;
}

/** Append one entry. The directory is created 700 and the file kept 600. */
export function appendSpend(logPath: string, entry: SpendEntry): void {
  if (!Number.isFinite(entry.usd) || entry.usd < 0) {
    throw new Error(`spend entry usd must be a finite number ≥ 0, got ${entry.usd}`);
  }
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  appendFileSync(logPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  chmodSync(logPath, 0o600);
}

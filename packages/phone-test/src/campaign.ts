import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { NUMBER_MONTHLY_USD, appendSpend, campaignSpendUsd, monthSpendUsd } from "./spend.js";
import type { TwilioNumbersClient } from "./twilio-numbers.js";

/** Every number the harness buys carries this FriendlyName, so a number whose
 * SID was never recorded (a crash, a lost response) can still be found. */
export const CAMPAIGN_FRIENDLY_NAME = "parley-test-campaign";

export interface CampaignState {
  id: string;
  /** `released`: `stop` released the number but has not finished the local
   * cleanup (allowlist line, sim, state file); never dialable. */
  status: "pending" | "active" | "released";
  number?: string;
  sid?: string;
  startedAt: string;
  budgetUsd: number;
}

export interface CampaignDeps {
  statePath: string;
  spendPath: string;
  /** The server's callable-numbers file (`PARLEY_CALLABLE_NUMBERS_FILE`). */
  allowlistPath: string;
  /** Monthly cap, USD. */
  budgetUsd: number;
  twilio: TwilioNumbersClient;
  /** Where Twilio sends the bought number's inbound calls: the sim's answer route. */
  voiceUrl: string;
  statusCallback?: string;
  startSim(): Promise<void> | void;
  stopSim(): Promise<void> | void;
  now(): Date;
}

export interface CampaignStatus {
  state?: CampaignState;
  ageHours?: number;
  monthSpendUsd: number;
  remainingUsd: number;
}

// ---------------------------------------------------------------------------
// State file

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function readState(path: string): CampaignState | undefined {
  if (!existsSync(path)) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    v = undefined;
  }
  const s = v as Partial<CampaignState> | undefined;
  if (
    !s ||
    typeof s !== "object" ||
    typeof s.id !== "string" ||
    (s.status !== "pending" && s.status !== "active" && s.status !== "released") ||
    typeof s.startedAt !== "string" ||
    typeof s.budgetUsd !== "number"
  ) {
    throw new Error(
      `campaign state file ${path} is unreadable; check the Twilio console for numbers named ` +
        `${CAMPAIGN_FRIENDLY_NAME}, then remove the file`
    );
  }
  return s as CampaignState;
}

function tmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/** Atomic replace, mode 600. */
function writeState(path: string, state: CampaignState): void {
  ensureDir(path);
  const tmp = tmpPath(path);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Atomic create-if-absent, mode 600: a hard link fails if the target exists,
 * so two concurrent starts cannot both get past this point. */
function createState(path: string, state: CampaignState): void {
  ensureDir(path);
  const tmp = tmpPath(path);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    linkSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`a test campaign already exists (${path}); run stop first`);
    }
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Callable-numbers file. Only the campaign's own line is ever added or
// removed; every other byte is left as it was.

/** Replace the file's contents atomically: write a temp file in the same
 * directory with the original's mode (600 if new), then rename it over the
 * original. The daemon re-reads this file on every permits() call, so it must
 * never be observable empty or half-written. A symlink is followed and its
 * target replaced, so the link itself stays in place. */
function replaceAtomically(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const tmp = tmpPath(target);
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function allowlistAdd(path: string, number: string): void {
  ensureDir(path);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  // A file without a trailing newline gets the number as a new last line, also
  // without one, so removing that line restores the original bytes.
  const add = text !== "" && !text.endsWith("\n") ? `\n${number}` : `${number}\n`;
  replaceAtomically(path, text + add);
}

/** Removes the last line that is exactly `number`. The campaign appended its
 * line at the end, so an operator's own entry for the same number survives. */
function allowlistRemove(path: string, number: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim() === number) {
      lines.splice(i, 1);
      replaceAtomically(path, lines.join("\n"));
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Buys the campaign number and brings the sim up. Refuses (before any Twilio
 * write) when a campaign already exists, the month's budget is spent, or the
 * account is Trial. Any failure after the pending state is written is rolled
 * back through `stopCampaign`; if that cleanup cannot finish, the state file is
 * kept so a later `stop` retries it. */
export async function startCampaign(deps: CampaignDeps): Promise<CampaignState> {
  if (existsSync(deps.statePath)) {
    throw new Error(`a test campaign already exists (${deps.statePath}); run stop first`);
  }
  const now = deps.now();
  const spent = monthSpendUsd(deps.spendPath, now);
  // The number's own fee is the first thing a campaign spends.
  if (spent + NUMBER_MONTHLY_USD > deps.budgetUsd) {
    throw new Error(
      `monthly budget reached: $${spent.toFixed(2)} of $${deps.budgetUsd.toFixed(2)} spent, ` +
        `and a number costs $${NUMBER_MONTHLY_USD.toFixed(2)}`
    );
  }
  if ((await deps.twilio.accountType()) === "Trial") {
    throw new Error("Twilio account is Trial; test campaigns need a Full (upgraded) account");
  }

  const startedAt = now.toISOString();
  const pending: CampaignState = {
    id: `c-${startedAt.replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`,
    status: "pending",
    startedAt,
    budgetUsd: deps.budgetUsd
  };
  createState(deps.statePath, pending);

  try {
    // If this throws, the purchase may still have landed (response lost, or a
    // timeout after Twilio committed); the rollback sweeps by FriendlyName.
    const bought = await deps.twilio.buyLocal({
      voiceUrl: deps.voiceUrl,
      ...(deps.statusCallback ? { statusCallback: deps.statusCallback } : {}),
      friendlyName: CAMPAIGN_FRIENDLY_NAME
    });
    // Twilio charges the month's fee at purchase, released or not: book it
    // before anything else can fail.
    appendSpend(deps.spendPath, {
      at: now.toISOString(),
      campaign: pending.id,
      callTag: "number-fee",
      minutes: 0,
      usd: NUMBER_MONTHLY_USD
    });
    const active: CampaignState = {
      ...pending,
      status: "active",
      number: bought.phoneNumber,
      sid: bought.sid
    };
    writeState(deps.statePath, active);
    allowlistAdd(deps.allowlistPath, bought.phoneNumber);
    await deps.startSim();
    return active;
  } catch (err) {
    try {
      await stopCampaign(deps);
    } catch (cleanupErr) {
      throw new Error(
        `campaign start failed (${message(err)}) and cleanup did not finish ` +
          `(${message(cleanupErr)}); state kept at ${deps.statePath}, run stop to retry`,
        { cause: err }
      );
    }
    throw err;
  }
}

/** Releases the campaign's number(s), drops it from the callable-numbers file,
 * stops the sim and deletes the state. Idempotent. Always sweeps by
 * FriendlyName as well as releasing the stored SID, so a number whose SID was
 * never recorded is still released. `released` lists the SIDs this call
 * released; one Twilio reports already gone counts as done but is not listed.
 * If any Twilio call fails, nothing local is touched and it throws, so a retry
 * starts from the same place. */
export async function stopCampaign(
  deps: CampaignDeps
): Promise<{ released: string[]; spentUsd: number }> {
  // An unreadable state file must not stop the leak backstop: sweep by
  // FriendlyName first, then report it.
  let state: CampaignState | undefined;
  let unreadable: unknown;
  try {
    state = readState(deps.statePath);
  } catch (err) {
    unreadable = err;
  }
  const released: string[] = [];
  const seen = new Set<string>();
  const errors: unknown[] = [];

  const release = async (sid: string): Promise<void> => {
    if (seen.has(sid)) return;
    seen.add(sid);
    try {
      if ((await deps.twilio.release(sid)) === "released") released.push(sid);
    } catch (err) {
      errors.push(err);
    }
  };

  if (state?.sid) await release(state.sid);
  try {
    for (const n of await deps.twilio.findByFriendlyName(CAMPAIGN_FRIENDLY_NAME)) {
      await release(n.sid);
    }
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) {
    throw new Error(
      `campaign stop incomplete: ${errors.length} Twilio error(s), first: ${message(errors[0])}; ` +
        `released so far: [${released.join(", ")}]; state kept, run stop again`,
      { cause: errors[0] }
    );
  }
  if (unreadable !== undefined) {
    throw new Error(
      `${message(unreadable)} (swept by FriendlyName first; released: [${released.join(", ")}])`,
      { cause: unreadable }
    );
  }

  if (!state) return { released, spentUsd: 0 };

  if (state.status === "active") {
    // Record the release before any local edit: if the allowlist edit below
    // fails, the state must not still read active with a number Twilio may
    // already have resold. A retry finishes from here.
    writeState(deps.statePath, { ...state, status: "released" });
  }
  if (state.status === "active" || state.status === "released") {
    if (state.number) allowlistRemove(deps.allowlistPath, state.number);
    try {
      await deps.stopSim();
    } catch {
      // The sim may already be gone; nothing here can leak money.
    }
  }
  rmSync(deps.statePath, { force: true });
  return { released, spentUsd: campaignSpendUsd(deps.spendPath, state.id) };
}

/** The current campaign (if any), its age, and this month's spend against the cap. */
export async function campaignStatus(deps: CampaignDeps): Promise<CampaignStatus> {
  const now = deps.now();
  const state = readState(deps.statePath);
  const spent = monthSpendUsd(deps.spendPath, now);
  const out: CampaignStatus = {
    monthSpendUsd: spent,
    remainingUsd: Math.max(0, deps.budgetUsd - spent)
  };
  if (state) {
    out.state = state;
    out.ageHours = (now.getTime() - Date.parse(state.startedAt)) / 3_600_000;
  }
  return out;
}

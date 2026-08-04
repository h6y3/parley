import type { CallSession } from "@parley/core";

/** Per-call registry keyed by Twilio CallSid (design spec §3). An ordinary
 * instance — never a module-level singleton — so V1's single-call limit and
 * later concurrency both respect the no-global-mutable-state rule (§8). */
export class PendingSessions {
  private readonly map = new Map<string, CallSession>();
  set(callId: string, session: CallSession): void { this.map.set(callId, session); }
  get(callId: string): CallSession | undefined { return this.map.get(callId); }
  delete(callId: string): void { this.map.delete(callId); }
  get size(): number { return this.map.size; }
}

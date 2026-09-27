import type { Brief, CallSession } from "@parley/core";

export type OperationReservation =
  "reserved" | "active" | "duplicate" | "out-of-sequence" | "configuration-conflict";

/** Per-call registry keyed by Twilio CallSid (design spec §3). An ordinary
 * instance — never a module-level singleton — so V1's single-call limit and
 * later concurrency both respect the no-global-mutable-state rule (§8). */
export class PendingSessions {
  private readonly map = new Map<string, CallSession>();
  private readonly connectedCalls = new Set<string>();
  private readonly operations = new Map<
    string,
    { highestAttempt: number; maxAttempts: number; active: boolean; callId?: string }
  >();
  private readonly callOperations = new Map<string, string>();

  reserveOperation(operation: NonNullable<Brief["operation"]>): OperationReservation {
    const current = this.operations.get(operation.id);
    if (!current) {
      if (operation.attempt !== 1) return "out-of-sequence";
      this.operations.set(operation.id, {
        highestAttempt: operation.attempt,
        maxAttempts: operation.maxAttempts,
        active: true
      });
      return "reserved";
    }
    if (current.maxAttempts !== operation.maxAttempts) return "configuration-conflict";
    if (current.active) return "active";
    if (operation.attempt <= current.highestAttempt) return "duplicate";
    if (operation.attempt !== current.highestAttempt + 1) return "out-of-sequence";
    current.highestAttempt = operation.attempt;
    current.active = true;
    delete current.callId;
    return "reserved";
  }

  releaseOperation(operation: NonNullable<Brief["operation"]>): void {
    const current = this.operations.get(operation.id);
    if (current?.highestAttempt === operation.attempt) {
      current.active = false;
      delete current.callId;
    }
  }

  set(callId: string, session: CallSession, operation?: Brief["operation"]): void {
    this.map.set(callId, session);
    if (operation) {
      const current = this.operations.get(operation.id);
      if (current) current.callId = callId;
      this.callOperations.set(callId, operation.id);
    }
  }
  get(callId: string): CallSession | undefined {
    return this.map.get(callId);
  }
  markConnected(callId: string): void {
    if (this.map.has(callId)) this.connectedCalls.add(callId);
  }
  deleteIfUnconnected(callId: string): void {
    if (!this.connectedCalls.has(callId)) this.delete(callId);
  }
  delete(callId: string): void {
    this.map.delete(callId);
    this.connectedCalls.delete(callId);
    const operationId = this.callOperations.get(callId);
    if (operationId) {
      const operation = this.operations.get(operationId);
      if (operation?.callId === callId) {
        operation.active = false;
        delete operation.callId;
      }
      this.callOperations.delete(callId);
    }
  }
  get size(): number {
    return this.map.size;
  }
}

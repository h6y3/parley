import { describe, expect, it } from "vitest";
import type { CallSession } from "@parley/core";
import { PendingSessions } from "../src/pending-sessions.js";

const operation = (attempt: number, maxAttempts = 3) => ({
  id: "delivery-order-123",
  attempt,
  maxAttempts
});

describe("PendingSessions operation lineage", () => {
  it("prevents concurrent and duplicate attempts, then allows the next attempt", () => {
    const pending = new PendingSessions();
    expect(pending.reserveOperation(operation(1))).toBe("reserved");
    expect(pending.reserveOperation(operation(1))).toBe("active");
    pending.set("CA1", {} as CallSession, operation(1));
    pending.delete("CA1");
    expect(pending.reserveOperation(operation(1))).toBe("duplicate");
    expect(pending.reserveOperation(operation(2))).toBe("reserved");
  });

  it("rejects skipped attempts and max-attempt changes", () => {
    const pending = new PendingSessions();
    expect(pending.reserveOperation(operation(2))).toBe("out-of-sequence");
    expect(pending.reserveOperation(operation(1))).toBe("reserved");
    pending.releaseOperation(operation(1));
    expect(pending.reserveOperation(operation(2, 4))).toBe("configuration-conflict");
    expect(pending.reserveOperation(operation(3))).toBe("out-of-sequence");
  });

  it("consumes a failed origination attempt without leaving it active", () => {
    const pending = new PendingSessions();
    expect(pending.reserveOperation(operation(1))).toBe("reserved");
    pending.releaseOperation(operation(1));
    expect(pending.reserveOperation(operation(1))).toBe("duplicate");
    expect(pending.reserveOperation(operation(2))).toBe("reserved");
  });

  it("releases a call that terminates before media connects, but not an attached call", () => {
    const pending = new PendingSessions();
    expect(pending.reserveOperation(operation(1))).toBe("reserved");
    pending.set("CA1", {} as CallSession, operation(1));
    pending.deleteIfUnconnected("CA1");
    expect(pending.get("CA1")).toBeUndefined();
    expect(pending.reserveOperation(operation(2))).toBe("reserved");
    pending.set("CA2", {} as CallSession, operation(2));
    pending.markConnected("CA2");
    pending.deleteIfUnconnected("CA2");
    expect(pending.get("CA2")).toBeDefined();
    expect(pending.reserveOperation(operation(3))).toBe("active");
  });
});

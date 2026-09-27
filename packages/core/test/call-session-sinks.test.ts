import { describe, expect, it } from "vitest";
import { CallSession } from "../src/call-session.js";
import type { AudioSink } from "../src/call-session.js";
import { MIXED_SOURCE, MULAW_8K } from "../src/index.js";
import { makeSessionParams, FakeSocket } from "./helpers/call-session-harness.js";

describe("CallSession audio sinks", () => {
  it("fans one inbound frame out to EVERY registered sink", async () => {
    const seen: string[] = [];
    const session = new CallSession(makeSessionParams());
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    session.addSink({ id: "a", accept: () => seen.push("a") });
    session.addSink({ id: "b", accept: () => seen.push("b") });
    socket.pushInbound({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
    expect(seen).toEqual(["a", "b"]);
  });

  it("removes a sink by id and leaves the others running", async () => {
    const seen: string[] = [];
    const session = new CallSession(makeSessionParams());
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    session.addSink({ id: "a", accept: () => seen.push("a") });
    session.addSink({ id: "b", accept: () => seen.push("b") });
    session.removeSink("a");
    socket.pushInbound({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
    expect(seen).toEqual(["b"]);
  });

  it("tracks phases as a SET so both planes can be live at once", async () => {
    const session = new CallSession(makeSessionParams());
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    expect([...session.phases]).toEqual(["speaking"]);
    session.enterPhase("listening");
    expect([...session.phases].sort()).toEqual(["listening", "speaking"]);
    session.leavePhase("speaking");
    expect([...session.phases]).toEqual(["listening"]);
  });

  it("rejects a duplicate sink id rather than silently shadowing one", async () => {
    const session = new CallSession(makeSessionParams());
    await session.attach("CA1", new FakeSocket());
    session.addSink({ id: "a", accept: () => {} });
    expect(() => session.addSink({ id: "a", accept: () => {} })).toThrow(/already registered/);
  });

  // Task 12 removes the realtime sink by the literal id "realtime". Nothing
  // else observes that string, so a rename would leave every other test here
  // green while silently breaking Task 12. Pin it via the duplicate-rejection
  // path already built above.
  it('registers the realtime sink under the literal id "realtime"', async () => {
    const session = new CallSession(makeSessionParams());
    await session.attach("CA1", new FakeSocket());
    expect(() => session.addSink({ id: "realtime", accept: () => {} })).toThrow(
      /already registered/
    );
  });

  it("keeps delivering to a sink another sink removes from inside its own accept", async () => {
    // Task 12's consent handoff swaps sinks from inside a sink's own accept.
    // The fan-out must snapshot before iterating, or splicing the live array
    // mid-iteration shifts a later sink into the removed slot and skips it —
    // a dropped frame on a live call, with no error.
    const seen: string[] = [];
    const session = new CallSession(makeSessionParams());
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    session.addSink({
      id: "a",
      accept: () => {
        seen.push("a");
        session.removeSink("b");
      }
    });
    session.addSink({ id: "b", accept: () => seen.push("b") });
    session.addSink({ id: "c", accept: () => seen.push("c") });
    socket.pushInbound({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("does not let one sink throwing block delivery to sinks registered after it", async () => {
    const seen: string[] = [];
    const diagnostics: string[] = [];
    const session = new CallSession({
      ...makeSessionParams(),
      onDiagnostic: (message) => diagnostics.push(message)
    });
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    session.addSink({
      id: "a",
      accept: () => {
        throw new Error("boom");
      }
    });
    session.addSink({ id: "b", accept: () => seen.push("b") });
    socket.pushInbound({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
    expect(seen).toEqual(["b"]);
    expect(diagnostics.some((d) => d.includes('audio sink "a" threw') && d.includes("boom"))).toBe(
      true
    );
  });

  // Finding 5: `AudioSink.accept` is typed `void`, and TypeScript assigns an
  // async function to a void-returning slot without a word. The isolation
  // above catches synchronous throws ONLY, so a sink that returns a rejecting
  // promise would put its failure outside every guard here — exactly the
  // unhandled rejection this isolation exists to prevent, and one that ends
  // the process rather than one sink's frame. The constraint was held by a
  // comment; this holds it.
  it("reports a sink that rejects asynchronously instead of letting it escape the fan-out", async () => {
    const seen: string[] = [];
    const diagnostics: string[] = [];
    const session = new CallSession({
      ...makeSessionParams(),
      onDiagnostic: (message) => diagnostics.push(message)
    });
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    session.addSink({
      id: "a",
      accept: (() => Promise.reject(new Error("boom"))) as unknown as AudioSink["accept"]
    });
    session.addSink({ id: "b", accept: () => seen.push("b") });
    socket.pushInbound({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["b"]);
    expect(diagnostics.some((d) => d.includes('audio sink "a" threw') && d.includes("boom"))).toBe(
      true
    );
  });

  it("clears sinks and phases in endCall so a late frame reaches nothing", async () => {
    const seen: string[] = [];
    const session = new CallSession(makeSessionParams());
    const socket = new FakeSocket();
    await session.attach("CA1", socket);
    session.addSink({ id: "a", accept: () => seen.push("a") });
    await session.endCall("remote");
    expect([...session.phases]).toEqual([]);
    socket.pushInbound({ encoding: MULAW_8K, data: Buffer.alloc(160) }, MIXED_SOURCE);
    expect(seen).toEqual([]);
  });
});

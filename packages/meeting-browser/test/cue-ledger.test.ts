import { describe, expect, it } from "vitest";
import { createCueLedger } from "../src/cue-ledger.js";

describe("createCueLedger", () => {
  /** A caption line is a thing on a screen, not an event: it stays up for
   * several seconds and every scrape re-stamps it with the instant of the
   * scrape. One sentence therefore arrives three to ten times, each copy
   * later than the last. */
  it("keeps a line seen on many polls once, at the time it was FIRST seen", () => {
    const ledger = createCueLedger();
    const line = { speaker: "Priya", text: "the deadline slipped" };

    expect(ledger.add({ ...line, atMs: 4000 })).toBe(true);
    expect(ledger.add({ ...line, atMs: 5000 })).toBe(false);
    expect(ledger.add({ ...line, atMs: 6000 })).toBe(false);

    expect(ledger.cues).toEqual([{ ...line, atMs: 4000 }]);
  });

  /** FIRST and not last: a caption appears once the words have been spoken
   * and recognised, so its first appearance is the closest this transport
   * gets to when they were said. Every re-stamp after that is the scraper's
   * own clock describing nothing that happened in the room — and a line held
   * on screen long enough drifts right out of the aligner's window. */
  it("does not let a later sighting move a cue's time", () => {
    const ledger = createCueLedger();
    ledger.add({ speaker: "Priya", text: "the deadline slipped", atMs: 100 });
    ledger.add({ speaker: "Priya", text: "the deadline slipped", atMs: 9000 });
    expect(ledger.cues[0]?.atMs).toBe(100);
  });

  it("keeps a different line from the same speaker, and the same line from a different speaker", () => {
    const ledger = createCueLedger();
    ledger.add({ speaker: "Priya", text: "the deadline slipped", atMs: 0 });
    ledger.add({ speaker: "Priya", text: "can we ship friday", atMs: 1000 });
    ledger.add({ speaker: "Sam", text: "can we ship friday", atMs: 2000 });
    expect(ledger.cues).toHaveLength(3);
  });

  /** The key is a pair, not a joined string. With `${speaker}|${text}` these
   * two collide, and one of the speakers loses a line they said. */
  it("does not confuse two lines that a separator would have merged", () => {
    const ledger = createCueLedger();
    ledger.add({ speaker: "A", text: "B|C", atMs: 0 });
    ledger.add({ speaker: "A|B", text: "C", atMs: 1000 });
    expect(ledger.cues).toHaveLength(2);
  });

  it("preserves the order lines were first seen in", () => {
    const ledger = createCueLedger();
    ledger.add({ speaker: "Priya", text: "first", atMs: 0 });
    ledger.add({ speaker: "Sam", text: "second", atMs: 1000 });
    ledger.add({ speaker: "Priya", text: "first", atMs: 2000 });
    ledger.add({ speaker: "Priya", text: "third", atMs: 3000 });
    expect(ledger.cues.map((c) => c.text)).toEqual(["first", "second", "third"]);
  });
});

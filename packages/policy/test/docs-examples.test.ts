import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCallEnvelope } from "../src/schema.js";

/**
 * The envelope examples in the docs must parse.
 *
 * Not pedantry — measured. Adding the spend-ceiling pairing rule made
 * `configuration.md`'s "complete v2 envelope" invalid the moment it landed, and
 * nothing would have said so: a reader copies it, gets a 400 with a field path
 * they did not write, and concludes the daemon is broken. Every future
 * cross-plane rule has the same failure mode, and this is the only check that
 * sees it.
 */
const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs");

function envelopeExamples(file: string): { file: string; body: string }[] {
  const text = readFileSync(join(DOCS, file), "utf8");
  const blocks = [...text.matchAll(/```json\n(\{[\s\S]*?\n\})\n```/g)].map((m) => m[1]);
  // Only complete envelopes — the docs also show fragments of single blocks,
  // which are illustrative and not parseable on their own.
  return blocks
    .filter((b) => b.includes('"version"') && b.includes('"brief"'))
    .map((body) => ({ file, body }));
}

describe("envelope examples in the docs parse", () => {
  const examples = ["configuration.md", "architecture.md", "security-model.md"].flatMap(
    envelopeExamples
  );

  it("finds the examples it is meant to be checking", () => {
    // A regex that silently matches nothing is a test that passes by finding
    // no work to do.
    expect(examples.length).toBeGreaterThan(0);
  });

  for (const [i, ex] of examples.entries()) {
    it(`${ex.file} example ${i + 1} is accepted by parseCallEnvelope`, () => {
      expect(() => parseCallEnvelope(JSON.parse(ex.body))).not.toThrow();
    });
  }
});

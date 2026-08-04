// examples/scenarios/validate.mjs — asserts every scenario is a valid envelope.
//
// This directory is a plain folder of JSON examples, not a pnpm workspace
// package, so a bare `import "@parley/policy"` run with plain `node` will not
// resolve through node_modules. Import the built package's dist output
// directly instead. Build it first:
//
//   pnpm --filter @parley/policy build
//
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCallEnvelope } from "../../packages/policy/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith(".json"));
let failed = 0;
for (const f of files) {
  try {
    parseCallEnvelope(JSON.parse(readFileSync(join(here, f), "utf8")));
    console.log(`ok   ${f}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}: ${e.message}`);
  }
}
if (files.length < 12) {
  console.error(`expected >=12 scenarios, found ${files.length}`);
  failed++;
}
process.exit(failed ? 1 : 0);

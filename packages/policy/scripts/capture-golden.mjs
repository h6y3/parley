// Regenerate the golden oracle: `node packages/policy/scripts/capture-golden.mjs`
// (requires `pnpm --filter @parley/core build` and `pnpm --filter @parley/policy
// build` first — this plain Node script resolves both packages by name against
// their built dist/ output, since Node's ESM loader (unlike vitest's) cannot
// resolve a ".js" specifier against a sibling ".ts" source file).
//
// Dumps today's renderSystemInstruction output for representative
// briefs into golden.json, the equivalence oracle used by
// test/golden-equivalence.test.ts. Case inputs must byte-match that
// test's render calls.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderSystemInstruction } from "@parley/core";
import { composePolicy, principalCall, representedCall, transactionalCall } from "@parley/policy";

const persona = "You are Ada, a calm, warm assistant.";
const objective = "Confirm a dinner reservation for four at 7pm on Friday.";
const facts = ["The reservation is under Alex Rivera.", "Party of four.", "7pm Friday."];
const render = (policy) => renderSystemInstruction({ persona, objective, facts, guardrails: composePolicy(policy) });

const out = {
  principal: render(principalCall({ principalName: "Alex Rivera" })),
  represented_full: render(representedCall({
    principalName: "Alex Rivera",
    callbackNumber: "+15551234567",
    authorizedCommitments: ["A table for four at 7pm on Friday is fine to confirm."],
    pronunciation: ["Pronounce the last name Rivera as ree-VAIR-uh."]
  })),
  represented_minimal: render(representedCall({ principalName: "Alex Rivera" })),
  transactional_full: render(transactionalCall({ principalName: "Alex Rivera", recipientName: "Bella Vista", callbackNumber: "+15551234567" }))
};

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "..", "test", "fixtures", "golden.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`wrote ${Object.keys(out).length} golden fixtures to ${dest}`);

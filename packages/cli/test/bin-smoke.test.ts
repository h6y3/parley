import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the tsup code-splitting bug where `dist/cli.js` became a
// re-export shim and the `import.meta.url === argv` self-invocation guard was
// hoisted into a chunk, so `main()` never ran when the bin was executed. This
// test executes the REAL built binary (not the source exports) and asserts main
// actually dispatched. Skips when dist isn't built (bare `test` run without a
// prior `build`); runs in the full build+test gate.
const cliDist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("parley bin self-invocation", () => {
  it.skipIf(!existsSync(cliDist))("runs main() and prints doctor output when executed as a binary", () => {
    const out = execFileSync(process.execPath, [cliDist, "doctor"], {
      env: {
        ...process.env,
        GEMINI_API_KEY: "x",
        TWILIO_AUTH_TOKEN: "",
        TWILIO_ACCOUNT_SID: "",
        TWILIO_FROM_NUMBER: ""
      },
      encoding: "utf8"
    });
    expect(out).toContain("GEMINI_API_KEY: present");
    expect(out).toContain("TWILIO_AUTH_TOKEN: MISSING");
  });
});

import { defineConfig } from "vitest/config";

/** The browser suite: the assertions that need a real Chromium, kept out of
 * the default run by `vitest.config.ts`. See that file for why the split is a
 * config rather than a skip guard.
 *
 * The timeouts are generous because the cost here is a browser launch and a
 * multi-megabyte captured page parse, neither of which is what any assertion
 * in this suite is about. */
export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
});

import { configDefaults, defineConfig } from "vitest/config";

/** The default run is the UNIT suite: pure Node, jsdom for markup, no browser
 * download and no network.
 *
 * `test/browser/` is excluded from it because those tests launch a real
 * Chromium through Playwright, which is a ~180 MB download the first time and
 * is not something `pnpm -r run test` should acquire on a fresh clone. They
 * are not optional in the sense of being unimportant — one of them is the only
 * evidence anywhere that the selector gating EVERY admission is accepted by
 * the engine that has to parse it. Run them with:
 *
 *     pnpm --filter @parley/meeting-browser exec playwright install chromium
 *     pnpm --filter @parley/meeting-browser run test:browser
 *
 * A separate config rather than a skip guard inside the file, deliberately: a
 * guarded test reports as passing-or-skipped depending on an environment
 * variable nobody sets, which is how a suite ends up claiming coverage it does
 * not have. Excluded here, the browser suite either runs and asserts or is
 * visibly not part of this command. */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/browser/**"]
  }
});

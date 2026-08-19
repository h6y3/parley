#!/usr/bin/env node
import { main } from "./cli.js";

/** Dedicated executable entry.
 *
 * `cli.ts` cannot carry the entry point itself: `index.ts` re-exports its
 * `main`, so tsup hoists its body into a shared chunk and the usual
 * `import.meta.url === pathToFileURL(process.argv[1]).href` guard compares the
 * CHUNK's url against the bin's path — never equal, so it never fires and the
 * binary silently does nothing. A file that is only ever an entry has no such
 * problem and needs no guard.
 */
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

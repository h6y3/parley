#!/usr/bin/env node
/** Dump an already-open page's DOM into the fixtures directory.
 *
 *   node --experimental-strip-types scripts/capture-meet-dom.ts <cdp-url> <name> [url-substring]
 *
 * Captures whatever is on screen right now — the operator drives which
 * meeting state gets captured by driving the meeting itself, then runs this
 * once per state. This script never launches a browser; it only ATTACHES,
 * over CDP, to a Chrome window the operator already started and signed in to
 * by hand. See docs/profile-setup.md for why that distinction is
 * load-bearing and how to start that window.
 *
 * [url-substring] picks which open page to capture, and is only required
 * when more than one page is open in that window — e.g. a leftover
 * accounts.google.com sign-in tab left over from setup, alongside the
 * meeting tab. A 2026-08-22 capture session had exactly that: this script
 * used to capture "whatever page is last in the context" and reported only a
 * byte count, so it silently captured the sign-in tab while the operator
 * believed they were capturing the meeting — the file looked plausible and
 * was wrong, caught only because the operator separately grepped the output
 * for the meeting id afterwards. It now refuses to guess: one open page
 * needs no substring; more than one, with no substring or a substring
 * matching zero or more than one page, is reported by name so the wrong
 * target is visible immediately rather than after the fact.
 *
 * Run from the package root (packages/meeting-browser), so the relative
 * paths in its own error messages resolve.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const FIXTURES_DIR = join(import.meta.dirname, "..", "test", "fixtures", "google-meet");

// Loose enough for names like "prejoin-ready" or "in-call-captions", strict
// enough that a typo (a stray space, a slash, a leading dot) fails here with
// a clear message instead of silently writing to a surprising path.
const VALID_NAME = /^[a-z][a-z0-9-]*$/;

const USAGE =
  "usage: node --experimental-strip-types scripts/capture-meet-dom.ts <cdp-url> <name> [url-substring]\n" +
  "  <cdp-url>       the CDP endpoint of a Chrome window you already started by hand\n" +
  "                  (see docs/profile-setup.md), e.g. http://127.0.0.1:9222\n" +
  '  <name>          what to call this capture, e.g. "prejoin-ready", "in-call"\n' +
  "  [url-substring] which open page to capture — only needed when more than one\n" +
  '                  page is open, e.g. the meeting code ("abc-defg-hij")';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listUrls(urls: readonly string[]): string {
  return urls.map((url, i) => `  ${i + 1}. ${url}`).join("\n");
}

export type PageSelection =
  { readonly ok: true; readonly index: number } | { readonly ok: false; readonly reason: string };

/** Pick which open page to capture, from URLs alone — no browser involved,
 * so this is testable without one.
 *
 * Exactly one open page needs no substring: there is nothing to disambiguate.
 * More than one requires a substring that narrows the field to exactly one
 * match. Zero open pages, zero matches, and more than one match are each
 * reported by name (the full list of what IS open) rather than resolved by
 * guessing — "whatever page is last in the context" was that guess, and it
 * is what silently captured a leftover sign-in tab on 2026-08-22. */
export function selectPageIndex(urls: readonly string[], urlSubstring?: string): PageSelection {
  if (urls.length === 0) {
    return {
      ok: false,
      reason:
        "that Chrome window has no open page.\n" +
        "Open the meeting (or any page) in that window, then run this again."
    };
  }
  if (urlSubstring === undefined) {
    if (urls.length === 1) return { ok: true, index: 0 };
    return {
      ok: false,
      reason:
        `${urls.length} pages are open and no url-substring was given to pick one:\n` +
        `${listUrls(urls)}\n\n` +
        "Re-run with a substring of the meeting page's URL (e.g. its meeting code) as a " +
        "third argument."
    };
  }
  const matches = urls
    .map((url, index) => ({ url, index }))
    .filter(({ url }) => url.includes(urlSubstring));
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `no open page's URL contains "${urlSubstring}". Open pages:\n${listUrls(urls)}`
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason:
        `"${urlSubstring}" matches ${matches.length} open pages — ambiguous:\n` +
        `${listUrls(matches.map((m) => m.url))}\n\n` +
        "Use a more specific substring."
    };
  }
  return { ok: true, index: matches[0].index };
}

async function main(argv: string[]): Promise<void> {
  const [cdpUrl, name, urlSubstring] = argv;
  if (!cdpUrl || !name) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!VALID_NAME.test(name)) {
    console.error(
      `"${name}" is not a valid capture name (lowercase letters, digits, and hyphens only, ` +
        `starting with a letter — e.g. "prejoin-ready"). Nothing was written.\n\n${USAGE}`
    );
    process.exitCode = 1;
    return;
  }

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    console.error(
      `Could not reach a Chrome DevTools endpoint at ${cdpUrl}.\n\n` +
        "This script only attaches to a browser — it never launches one. Start Chrome by " +
        "hand first, following docs/profile-setup.md, then run this again against the same " +
        `URL.\n\nUnderlying error: ${describeError(error)}`
    );
    process.exitCode = 1;
    return;
  }

  try {
    const pages = browser.contexts()[0]?.pages() ?? [];
    const selection = selectPageIndex(
      pages.map((p) => p.url()),
      urlSubstring
    );
    if (!selection.ok) {
      console.error(`Connected to ${cdpUrl}, but ${selection.reason}`);
      process.exitCode = 1;
      return;
    }
    const page: Page = pages[selection.index];

    const title = await page.title();
    const html = await page.content();

    // Report what was actually captured, not just how much — a byte count
    // alone made a leftover accounts.google.com sign-in tab look like a
    // successful capture on 2026-08-22. Printed before the file is written
    // so a wrong target is visible immediately, not just recoverable from
    // the file afterwards.
    console.log(`captured page: ${page.url()}`);
    console.log(`  title: "${title}"`);

    try {
      await mkdir(FIXTURES_DIR, { recursive: true });
    } catch (error) {
      console.error(
        `Could not create the fixtures directory ${FIXTURES_DIR}: ${describeError(error)}\n` +
          "Create it by hand and try again."
      );
      process.exitCode = 1;
      return;
    }

    const out = join(FIXTURES_DIR, `${name}.html`);
    await writeFile(out, html, "utf8");
    console.log(`wrote ${out} (${html.length} bytes)`);
  } finally {
    // Disconnects Playwright from the CDP endpoint; the operator's Chrome
    // window (which this script never launched) stays open either way.
    await browser.close().catch(() => {});
  }
}

// Run only when this file is executed directly, not when something imports
// its exports — matches the guard in
// packages/harness/src/generate-fixtures.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

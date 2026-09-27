import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IN_CALL_ANCHORS,
  IN_CALL_ANCHOR_SELECTOR,
  IN_CALL_ANCHOR_VISIBLE_SELECTOR
} from "../../src/google-meet.js";

/** The one value in this package that had no evidence.
 *
 * `IN_CALL_ANCHOR_VISIBLE_SELECTOR` is the ONLY query `isAdmitted` is allowed
 * to run, so if Playwright rejected it or resolved it to zero, `isAdmitted`
 * would be permanently false and EVERY join would time out. Its only
 * assertions were that it string-equals its own derivation and that jsdom
 * rejects it — and nothing in the unit suite imports Playwright, so nothing
 * anywhere proved that Playwright accepts a comma-separated list with
 * `:visible` on each member, which is the exact shape this constant has.
 *
 * "No value without evidence" is this package's own standard; this file is
 * that value's evidence. Kept out of the default run because it needs a
 * browser binary — see `vitest.config.ts` for why that is an exclusion rather
 * than a skip guard, and `README.md` for how to run it.
 *
 * Every page here is a committed capture loaded from disk over `file://`. No
 * markup is authored; the one test that modifies anything says so in its name
 * and does it in the page, never to the file. */
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "google-meet");

const PREJOIN_READY = "prejoin-ready.html";
const PREJOIN_WAITING = "prejoin-waiting.html";
const IN_CALL = "in-call.html";
const IN_CALL_CAPTIONS = "in-call-captions.html";
const IN_CALL_CAPTIONS_OFF = "in-call-captions-off.html";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

async function open(fixture: string): Promise<void> {
  await page.goto(pathToFileURL(join(FIXTURES, fixture)).href);
}

describe("IN_CALL_ANCHOR_VISIBLE_SELECTOR, in the engine that has to parse it", () => {
  it("is accepted by Playwright as one comma-separated list with :visible on each member", async () => {
    // The load-bearing assertion, and the one that had no evidence at all.
    // `:visible` is a Playwright CSS extension; whether it is accepted PER
    // MEMBER of a selector list, rather than only on a single selector, is a
    // property of Playwright's parser that no amount of string comparison in
    // the unit suite can establish. A throw here means every join times out.
    await open(IN_CALL);
    await expect(page.locator(IN_CALL_ANCHOR_VISIBLE_SELECTOR).count()).resolves.toBeGreaterThan(0);
  });

  it("resolves each anchor to exactly one visible element on both in-call captures", async () => {
    // Per anchor rather than over the joined list: the list passing says only
    // that SOME member survived, and the point of a set is that each member
    // is independently evidence.
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS]) {
      await open(fixture);
      for (const anchor of IN_CALL_ANCHORS) {
        expect(await page.locator(`${anchor}:visible`).count(), `${anchor} in ${fixture}`).toBe(1);
      }
      expect(await page.locator(IN_CALL_ANCHOR_VISIBLE_SELECTOR).count()).toBe(
        IN_CALL_ANCHORS.length
      );
    }
  });

  it("resolves to zero on both pre-join captures, so the lobby cannot read as admitted", async () => {
    for (const fixture of [PREJOIN_READY, PREJOIN_WAITING]) {
      await open(fixture);
      expect(await page.locator(IN_CALL_ANCHOR_VISIBLE_SELECTOR).count(), fixture).toBe(0);
    }
  });

  it("still resolves positive with captions genuinely off, on the real capture that has them off", async () => {
    // The set's whole design point, checked through the query `join` actually
    // runs rather than through the plain list the unit suite uses.
    await open(IN_CALL_CAPTIONS_OFF);
    expect(await page.locator(IN_CALL_ANCHOR_VISIBLE_SELECTOR).count()).toBe(
      IN_CALL_ANCHORS.length - 1
    );
  });

  it("finds the live-region anchor is NOT zero-area, settling a cost this module could only state", async () => {
    // `google-meet.ts` names this as the stated cost of narrowing to
    // `:visible`: Playwright treats a zero-area element as not visible, and
    // `Call feature notifications and actions` is a live region — the kind of
    // element commonly rendered zero-size for screen readers. No capture
    // could answer it, because answering it needs layout. This does: the
    // element has a box, so the member contributes.
    await open(IN_CALL);
    const liveRegion = '[role="region"][aria-label="Call feature notifications and actions"]';
    expect(await page.locator(`${liveRegion}:visible`).count()).toBe(1);
    const box = await page.locator(liveRegion).first().boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);
  });

  it("reads a MODELLED mounted-but-hidden in-call page as not admitted, where the plain list reads it as in-call", async () => {
    // The reason the visible list exists, under the real engine. MODELLED,
    // and named so: every anchor is absent from the pre-join captures'
    // DOM entirely, so no capture of a hidden one can exist. The mechanism is
    // grounded — `in-call.html` carries `display: none` on real Meet
    // containers of its own — and the modification is made in the page, never
    // to the committed file.
    await open(IN_CALL);
    await page.evaluate((anchors: readonly string[]) => {
      for (const anchor of anchors) {
        for (const el of document.querySelectorAll(anchor)) {
          (el as HTMLElement).style.display = "none";
        }
      }
    }, IN_CALL_ANCHORS);

    // The premise: every anchor is still THERE. A visibility-blind count
    // reads the whole set; only a visibility-aware one reads zero.
    expect(await page.locator(IN_CALL_ANCHOR_SELECTOR).count()).toBe(IN_CALL_ANCHORS.length);
    expect(await page.locator(IN_CALL_ANCHOR_VISIBLE_SELECTOR).count()).toBe(0);
  });
});

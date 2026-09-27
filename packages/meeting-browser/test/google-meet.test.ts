import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JoinLocator, JoinPage } from "../src/join-driver.js";
import { classifyPreJoin } from "../src/join-driver.js";
import { driveToggle } from "../src/join-driver.js";
import {
  CAPTION_RESIDUAL_TOLERANCE_CHARS,
  ENSURE_CAPTIONS_ATTEMPTS,
  ENSURE_CAPTIONS_POLL_MS,
  IN_CALL_ANCHORS,
  IN_CALL_ANCHOR_SELECTOR,
  IN_CALL_ANCHOR_VISIBLE_SELECTOR,
  IN_CALL_CONTROLS,
  IN_MEETING_MARKERS,
  LOBBY_POPULATED_TOOLBAR,
  PRE_JOIN,
  SELECTORS,
  googleMeetAdapter
} from "../src/google-meet.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "google-meet");

/** The four captures taken in the first session, by the meeting state each
 * one holds. A fifth is declared below. Every assertion in this file is made
 * against one of the five, or against one of them with something DELETED —
 * never against markup written here, and the tests that MODIFY rather than
 * delete say `modelled` in their names. See fixtures/google-meet/README.md
 * for why that rule exists. */
const PREJOIN_READY = "prejoin-ready.html";
const PREJOIN_WAITING = "prejoin-waiting.html";
const IN_CALL = "in-call.html";
const IN_CALL_CAPTIONS = "in-call-captions.html";
const ALL_CAPTURES = [PREJOIN_READY, PREJOIN_WAITING, IN_CALL, IN_CALL_CAPTIONS] as const;

/** A fifth real capture, added after the four above: in-call, admitted, with
 * captions genuinely switched OFF rather than merely absent from a pre-join
 * screen. Kept out of `ALL_CAPTURES` because the tests that loop over that
 * constant are STATE-SPECIFIC — they assert a per-state expectation and would
 * need a fifth expectation to take a fifth state — so it is referenced
 * explicitly wherever a state matters. See the fixture README's
 * "in-call-captions-off.html" entry for provenance. */
const IN_CALL_CAPTIONS_OFF = "in-call-captions-off.html";

/** Every capture on disk, for the checks that are STATE-AGNOSTIC: an
 * invariant asserted of the corpus as a whole, holding for a pre-join screen
 * and an in-call page alike.
 *
 * A separate constant rather than a fifth entry in `ALL_CAPTURES`, and the
 * distinction is the point. The exclusion above is about states needing their
 * own expectations; an invariant that names no state has no such reason, and
 * excluding the fifth capture from one was leaving a real file unchecked
 * against a rule that covers it. Anything asserted of "any capture" belongs
 * here; anything asserted of a particular meeting state does not. */
const WHOLE_CORPUS = [...ALL_CAPTURES, IN_CALL_CAPTIONS_OFF] as const;

type FixtureDocument = JSDOM["window"]["document"];

async function fixtureDocument(file: string): Promise<FixtureDocument> {
  return new JSDOM(await readFile(join(FIXTURES, file), "utf8")).window.document;
}

/** Minimal stand-in for Playwright's `Page`: the one method the scrapers use,
 * backed by a real DOM parsed from a fixture. The scrapers read the global
 * `document`, exactly as they do inside a browser, so the global is installed
 * for the duration of the call and removed again — a leaked `document` would
 * let one test's DOM answer another test's query. */
function pageFor(document: FixtureDocument) {
  return {
    evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R> {
      (globalThis as unknown as Record<string, unknown>).document = document;
      try {
        return Promise.resolve(fn(arg));
      } finally {
        delete (globalThis as unknown as Record<string, unknown>).document;
      }
    }
  };
}

async function fixturePage(file: string) {
  return pageFor(await fixtureDocument(file));
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as Record<string, unknown>).document;
});

describe("SELECTORS", () => {
  // A selector is only evidence while it still matches the capture it was
  // read off. This is the check that fails first if someone edits SELECTORS
  // from memory instead of from the markup.
  const evidence: ReadonlyArray<{ readonly selector: string; readonly fixture: string }> = [
    { selector: SELECTORS.captionsRegion, fixture: IN_CALL_CAPTIONS },
    { selector: SELECTORS.captionLine, fixture: IN_CALL_CAPTIONS },
    { selector: SELECTORS.captionSpeaker, fixture: IN_CALL_CAPTIONS },
    { selector: SELECTORS.captionText, fixture: IN_CALL_CAPTIONS },
    { selector: SELECTORS.participantTile, fixture: IN_CALL },
    { selector: SELECTORS.participantName, fixture: IN_CALL },
    { selector: SELECTORS.leaveCallButton, fixture: IN_CALL },
    ...IN_CALL_ANCHORS.map((selector) => ({ selector, fixture: IN_CALL }))
  ];

  it.each(evidence)(
    "$selector still matches something in $fixture",
    async ({ selector, fixture }) => {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(selector).length).toBeGreaterThan(0);
    }
  );

  it.each(IN_CALL_ANCHORS.map((selector) => ({ selector })))(
    "admission anchor $selector matches in BOTH in-call captures and in NEITHER pre-join capture",
    async ({ selector }) => {
      // Asserted per anchor, not over the joined list, because the joined
      // list passing tells you only that SOME member survived — and the whole
      // point of a set is that each member is independently evidence. An
      // anchor that quietly stopped matching would hide behind its
      // neighbours in a list-level assertion.
      //
      // The zero half is the load-bearing half. leaveCallButton and
      // participantTile both already match once in prejoin-waiting.html (Meet
      // shows a preview tile and lobby chrome while you knock), so neither
      // can tell "admitted" apart from "still waiting"; an anchor that
      // matched anything pre-join would report admission from the lobby and
      // start the audio tap there.
      for (const fixture of [IN_CALL, IN_CALL_CAPTIONS]) {
        const document = await fixtureDocument(fixture);
        expect(document.querySelectorAll(selector)).toHaveLength(1);
      }
      for (const fixture of [PREJOIN_READY, PREJOIN_WAITING]) {
        const document = await fixtureDocument(fixture);
        expect(document.querySelectorAll(selector)).toHaveLength(0);
      }
    }
  );

  it("finds the call-controls region and most of its chrome ALREADY RENDERED in the lobby", async () => {
    // What the anchors' zero columns actually mean. The toolbar is not built
    // on admission — it is already there in prejoin-waiting.html, and
    // admission merely adds buttons to it. An anchor scores 0 pre-join
    // because Meet did not put THAT control in a toolbar it had already
    // drawn: a product decision, not an architectural boundary. A future
    // build that populates one more of them pre-join breaks that anchor with
    // nothing else changing, and this is the assertion that would say so.
    const waiting = await fixtureDocument(PREJOIN_WAITING);
    expect(waiting.querySelectorAll('[role="region"][aria-label="Call controls"]')).toHaveLength(1);

    const labelsOf = (document: FixtureDocument) =>
      new Set(
        [...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"))
      );
    const lobby = labelsOf(waiting);
    const inCall = labelsOf(await fixtureDocument(IN_CALL));

    for (const shared of [
      "Call controls",
      "Chat with everyone",
      "Leave call",
      "Audio settings",
      "Video settings",
      "More options",
      "Backgrounds and effects",
      "Reframe"
    ]) {
      expect(lobby.has(shared)).toBe(true);
      expect(inCall.has(shared)).toBe(true);
    }
    expect([...inCall].filter((label) => lobby.has(label))).toHaveLength(15);
  });

  it("keeps admission on MORE THAN ONE anchor, so no single host policy can silence it", async () => {
    // The finding this set exists to close: [aria-label="Share screen"] is
    // host-configurable, and a host who restricts presenting leaves a
    // genuinely admitted bot with no share control — reporting
    // waiting_room_timeout from inside the meeting. Pinned as a count so a
    // future edit cannot quietly collapse the set back to one selector.
    expect(IN_CALL_ANCHORS.length).toBeGreaterThan(1);
    // And the set must not be load-bearing on any ONE member: deleting each
    // in turn from a real in-call capture must still read as admitted.
    // Per-member rather than on the one control this started as, because the
    // property wanted is "no single point of failure", not "not that one".
    for (const anchor of IN_CALL_ANCHORS) {
      const document = await fixtureDocument(IN_CALL);
      for (const el of document.querySelectorAll(anchor)) el.remove();
      expect(document.querySelectorAll(anchor)).toHaveLength(0);
      expect(document.querySelectorAll(IN_CALL_ANCHOR_SELECTOR).length, anchor).toBeGreaterThan(0);
    }
  });

  /** Under any-match semantics the WEAKEST member alone sets the
   * false-positive floor, and a false positive here starts an
   * all-system-audio capture outside a meeting. `[aria-label="Share screen"]`
   * was the weakest the set had and is gone; this is the membership rule that
   * keeps it, and anything like it, out — stated structurally so it survives
   * an edit that only re-checks the capture counts.
   *
   * The premise is measured, not assumed: Meet renders the call-controls
   * toolbar in the LOBBY already populated, so a member inside it scores zero
   * pre-join only because of which buttons Meet currently chooses to put
   * there. One more lobby button and that member fires from the waiting
   * room. */
  it("places no admission anchor inside the toolbar the LOBBY already renders populated", async () => {
    const waiting = await fixtureDocument(PREJOIN_WAITING);
    const lobbyToolbar = waiting.querySelector(LOBBY_POPULATED_TOOLBAR);
    expect(lobbyToolbar).not.toBeNull();
    // Populated in the lobby, not merely present: six controls, before
    // admission.
    expect(lobbyToolbar?.querySelectorAll('[role="button"], button').length).toBeGreaterThanOrEqual(
      6
    );

    const inCall = await fixtureDocument(IN_CALL);
    const inCallToolbar = inCall.querySelector(LOBBY_POPULATED_TOOLBAR);
    expect(inCallToolbar).not.toBeNull();
    for (const anchor of IN_CALL_ANCHORS) {
      expect(inCallToolbar?.querySelectorAll(anchor).length, anchor).toBe(0);
    }

    // The control this rule removed, shown to be exactly what it excludes —
    // present in-call, and inside that toolbar.
    expect(inCall.querySelectorAll('[aria-label="Share screen"]')).toHaveLength(1);
    expect(inCallToolbar?.querySelectorAll('[aria-label="Share screen"]')).toHaveLength(1);
    expect(IN_CALL_ANCHORS).not.toContain('[aria-label="Share screen"]');
  });

  it("keeps the plain anchor list free of Playwright-only syntax, and the visible list derived from it", () => {
    // Two constants, on purpose. The plain list is what the evidence tests
    // above run through querySelectorAll, which is how each anchor's counts
    // stay measurable against the real captures; the visible list is what
    // join() actually queries. `:visible` is Playwright's own CSS extension
    // (present in the installed playwright-core's customCSSNames), so a
    // standard DOM rejects it outright — asserted here rather than assumed,
    // because that rejection is the whole reason the plain list cannot
    // simply be replaced.
    expect(IN_CALL_ANCHOR_SELECTOR).not.toContain(":visible");
    expect(IN_CALL_ANCHOR_VISIBLE_SELECTOR).toBe(
      IN_CALL_ANCHORS.map((anchor) => `${anchor}:visible`).join(", ")
    );
  });

  it("is rejected by a standard DOM, which is why the plain list still exists", async () => {
    const document = await fixtureDocument(IN_CALL);
    expect(() => document.querySelectorAll(IN_CALL_ANCHOR_VISIBLE_SELECTOR)).toThrow();
  });

  it("resolves the joined anchor list to zero on both pre-join captures", async () => {
    // The exact query join() runs each poll. Positive here would mean the
    // lobby reads as admitted.
    for (const fixture of [PREJOIN_READY, PREJOIN_WAITING]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(IN_CALL_ANCHOR_SELECTOR)).toHaveLength(0);
    }
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(IN_CALL_ANCHOR_SELECTOR)).toHaveLength(
        IN_CALL_ANCHORS.length
      );
    }
  });

  it("anchors the captions region on exactly one element, in both in-call captures", async () => {
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(SELECTORS.captionsRegion)).toHaveLength(1);
    }
  });

  it("finds the quiet captions region is NOT textless — its chrome is, and only its chrome", async () => {
    // The reason readCaptions cannot simply ask "does the region hold text".
    // in-call.html is a real capture with captions ON and nobody yet spoken,
    // and its region still holds "arrow_downwardJump to bottom" — the
    // jump-to-latest control's icon ligature and label. Both are
    // aria-hidden="true"; subtracting them is what leaves zero.
    const quiet = await fixtureDocument(IN_CALL);
    const region = quiet.querySelector(SELECTORS.captionsRegion);
    expect(region).not.toBeNull();
    expect((region?.textContent ?? "").trim().length).toBeGreaterThan(0);
    expect(region?.querySelectorAll(SELECTORS.captionDecorative)).toHaveLength(2);
    for (const decorative of region?.querySelectorAll(SELECTORS.captionDecorative) ?? []) {
      decorative.remove();
    }
    expect((region?.textContent ?? "").trim()).toBe("");
  });

  it('marks no element aria-hidden="false" in any capture, so the decorative selector is exact', async () => {
    // captionDecorative matches the literal "true". That is only equivalent
    // to matching mere presence while no element carries any other value —
    // asserted rather than assumed, since a future capture carrying
    // aria-hidden="false" would make the two readings differ.
    //
    // WHOLE_CORPUS, not ALL_CAPTURES: this names no meeting state, so every
    // file on disk is in scope. It ran over four of the five for no reason
    // that applied to it.
    for (const fixture of WHOLE_CORPUS) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll('[aria-hidden="false"]')).toHaveLength(0);
    }
  });

  it("separates a captioned region from a quiet one by speaker avatar alone", async () => {
    // The discriminator readCaptions leans on when no caption line matches.
    // It has to hold independently of the caption-line class, which is the
    // thing assumed to have rotated in that scenario — so it is asserted
    // here on its own, against both real in-call captures.
    const captioned = await fixtureDocument(IN_CALL_CAPTIONS);
    const quiet = await fixtureDocument(IN_CALL);
    const avatarsIn = (document: FixtureDocument) =>
      document.querySelector(SELECTORS.captionsRegion)?.querySelectorAll(SELECTORS.captionAvatar)
        .length;
    expect(avatarsIn(captioned)).toBeGreaterThan(0);
    expect(avatarsIn(quiet)).toBe(0);
  });

  it("finds exactly one name per participant tile, in every capture that has tiles", async () => {
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS, PREJOIN_WAITING]) {
      const document = await fixtureDocument(fixture);
      const tiles = document.querySelectorAll(SELECTORS.participantTile);
      expect(tiles.length).toBeGreaterThan(0);
      for (const tile of tiles) {
        expect(tile.querySelectorAll(SELECTORS.participantName)).toHaveLength(1);
      }
    }
  });
});

describe("PRE_JOIN", () => {
  it("matches exactly one camera toggle and one microphone toggle, in both pre-join captures", async () => {
    for (const fixture of [PREJOIN_READY, PREJOIN_WAITING]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(PRE_JOIN.cameraToggle)).toHaveLength(1);
      expect(document.querySelectorAll(PRE_JOIN.micToggle)).toHaveLength(1);
    }
  });

  it("does not also match the camera/microphone DEVICE SELECTOR buttons, which share the word but not role=button", async () => {
    // prejoin-ready.html's "Camera: Camera not found" / "Microphone: Mic not
    // found" device-selector buttons are real <button> elements without an
    // explicit role="button" attribute — verified by parsing the capture.
    // The combined [role="button"][aria-label*=...] selector is what keeps
    // PRE_JOIN pointed at the mute toggle instead of the device picker.
    const document = await fixtureDocument(PREJOIN_READY);
    const cameraMatches = [...document.querySelectorAll(PRE_JOIN.cameraToggle)];
    const micMatches = [...document.querySelectorAll(PRE_JOIN.micToggle)];
    expect(cameraMatches.map((el) => el.getAttribute("aria-label"))).toEqual(["Turn off camera"]);
    expect(micMatches.map((el) => el.getAttribute("aria-label"))).toEqual(["Turn off microphone"]);
  });

  it("reads the mute-toggle aria-labels as the ACTION, not the current state", async () => {
    // prejoin-ready.html: data-is-muted="false" on both toggles — currently
    // ON — and the label reads "Turn off X". prejoin-waiting.html: captured
    // after the devices were turned off before asking to join — the label
    // reads "Turn on X".
    const ready = await fixtureDocument(PREJOIN_READY);
    expect(ready.querySelector(PRE_JOIN.cameraToggle)?.getAttribute("data-is-muted")).toBe("false");
    expect(ready.querySelector(PRE_JOIN.cameraToggle)?.getAttribute("aria-label")).toBe(
      "Turn off camera"
    );

    const waiting = await fixtureDocument(PREJOIN_WAITING);
    expect(waiting.querySelector(PRE_JOIN.cameraToggle)?.getAttribute("aria-label")).toBe(
      "Turn on camera"
    );
    expect(waiting.querySelector(PRE_JOIN.micToggle)?.getAttribute("aria-label")).toBe(
      "Turn on microphone"
    );
  });

  it("matches exactly one join control in the ready capture, whose full accessible name names both devices", async () => {
    const document = await fixtureDocument(PREJOIN_READY);
    const matches = [...document.querySelectorAll(PRE_JOIN.joinButton)];
    expect(matches).toHaveLength(1);
    expect(matches[0].getAttribute("aria-label")).toBe("Ask to join without microphone & camera");
    // The full accessible name is the aria-label; the rendered text a human
    // sees is the shorter "Ask to join" — both are exercised by
    // classifyPreJoin's /ask to join/i pattern.
    expect(matches[0].textContent).toContain("Ask to join");
    expect(matches[0].textContent).not.toContain("without microphone");
  });

  it("finds no <input> element in either real pre-join capture", async () => {
    // Both captures were taken signed in to a Google account; Meet does not
    // offer a name field to a signed-in participant. nameField is real only
    // for the anonymous-join path, which this capture session never
    // exercised — see PRE_JOIN's own comment in google-meet.ts.
    for (const fixture of [PREJOIN_READY, PREJOIN_WAITING]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll("input")).toHaveLength(0);
      expect(document.querySelectorAll(PRE_JOIN.nameField)).toHaveLength(0);
    }
  });
});

describe("classifyPreJoin against the real captures", () => {
  it("finds no pre-join phrase anywhere in either in-call capture's text", async () => {
    // The premise behind confining classification to non-admitted pages: if
    // a pre-join phrase already collided with real in-call content, the
    // classifier would have been mis-firing since it was written. It does
    // not — checked here rather than asserted, and checked against
    // textContent, which is STRICTER than the innerText the join loop reads:
    // it includes text Meet renders hidden, so a phrase buried in a
    // collapsed menu counts against us too.
    //
    // This is a snapshot, not a guarantee. These captures hold two
    // participants, one spoken sentence and a closed chat panel. Captions,
    // chat and display names are all attacker- or colleague-supplied text on
    // a real call; nobody can promise none of it will ever read "you can't
    // join". That is why the loop no longer classifies an admitted page at
    // all, rather than relying on this staying true.
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS]) {
      const document = await fixtureDocument(fixture);
      expect(classifyPreJoin(document.body.textContent ?? "")).toBeUndefined();
    }
  });

  it("still classifies both real pre-join captures, so the gate cannot be silencing them", async () => {
    const ready = await fixtureDocument(PREJOIN_READY);
    expect(classifyPreJoin(ready.body.textContent ?? "")).toBe("admitted");
    const waiting = await fixtureDocument(PREJOIN_WAITING);
    expect(classifyPreJoin(waiting.body.textContent ?? "")).toBe("waiting_room_timeout");
  });

  it("puts every pre-join capture on the classified side of the gate, and every in-call capture off it", async () => {
    // The gate is "no in-call anchor matches". It only works if that
    // partition lines up exactly with pre-join versus in-call — asserted
    // directly, because a single anchor drifting into a pre-join screen
    // would silence the classifier there and turn a denied join into a
    // timeout.
    for (const fixture of [PREJOIN_READY, PREJOIN_WAITING]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(IN_CALL_ANCHOR_SELECTOR)).toHaveLength(0);
    }
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(IN_CALL_ANCHOR_SELECTOR).length).toBeGreaterThan(0);
    }
  });
});

describe("googleMeetAdapter.readCaptions", () => {
  it("reads the caption line with its speaker, from the real captions capture", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:04:05.000Z"));

    const cues = await googleMeetAdapter.readCaptions(await fixturePage(IN_CALL_CAPTIONS));

    expect(cues).toHaveLength(1);
    expect(cues[0].speaker).toBe("Jordan Rivera");
    expect(cues[0].text).toContain("We decide to ship the readout without the promotion engine.");
    // Meet leaves trailing whitespace in the caption text node; a cue carries
    // the words, not the padding.
    expect(cues[0].text).toBe(cues[0].text.trim());
    // atMs stamps when the cue was OBSERVED. The adapter deliberately does not
    // know the session's t0.
    expect(cues[0].atMs).toBe(Date.parse("2026-08-22T17:04:05.000Z"));
  });

  it("returns no cues when the captions region is present and nobody has spoken yet", async () => {
    // in-call.html is a real capture taken with captions already switched on
    // (its toggle reads "Turn off captions", i.e. the action, so captions are
    // on) before anyone had spoken. Region present, no lines: that IS a quiet
    // moment, and must not throw.
    expect(await googleMeetAdapter.readCaptions(await fixturePage(IN_CALL))).toEqual([]);
  });

  it("throws when the captions region is absent entirely", async () => {
    // A silent [] here is a meeting that merely looks quiet, which is
    // indistinguishable from a real quiet meeting. This is the check that
    // turns "Google changed their DOM" into a loud failure instead of months
    // of empty transcripts. prejoin-ready.html is a real capture with no
    // captions region anywhere in it.
    await expect(googleMeetAdapter.readCaptions(await fixturePage(PREJOIN_READY))).rejects.toThrow(
      /captions region/i
    );
  });

  it("throws for the SAME reason on a real in-call page with captions switched off — the case the fixture README used to say no capture could show", async () => {
    // Before in-call-captions-off.html existed, the only evidence for "the
    // region does not survive being switched off" was that PREJOIN_READY —
    // a pre-join screen — also lacks it, which proves nothing about an
    // admitted call. This capture is admitted (its data-participant-id tile
    // and Leave-call control are both present) and its captions toggle
    // reads "Turn on captions", the label Meet uses only when they are
    // currently off. The region still matches zero. That the same failure
    // mode covers both a screen before the call and a state inside it is
    // itself new information, not assumed by the pre-join case above.
    const document = await fixtureDocument(IN_CALL_CAPTIONS_OFF);
    expect(document.querySelectorAll(SELECTORS.leaveCallButton)).toHaveLength(1);
    expect(document.querySelectorAll(SELECTORS.captionsRegion)).toHaveLength(0);
    await expect(
      googleMeetAdapter.readCaptions(await fixturePage(IN_CALL_CAPTIONS_OFF))
    ).rejects.toThrow(/captions region/i);
  });

  it("throws when the region still holds a speaker avatar but no caption line matches", async () => {
    // Derived from in-call-captions.html by DELETION: the caption line's
    // generated class attribute is removed, which is what a Meet class
    // rotation does to a selector keyed on it. Nothing was added. The speaker
    // avatar survives, so the region demonstrably still holds caption
    // content — and an empty result would be a lie about a meeting that was
    // being captioned.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    expect(region).not.toBeNull();
    region?.querySelector(SELECTORS.captionLine)?.removeAttribute("class");
    expect(region?.querySelectorAll(SELECTORS.captionLine)).toHaveLength(0);
    expect(region?.querySelectorAll(SELECTORS.captionAvatar).length).toBeGreaterThan(0);

    await expect(googleMeetAdapter.readCaptions(pageFor(document))).rejects.toThrow(
      /caption line/i
    );
  });

  it("throws on a rotated caption class even when the speaker has NO profile photo", async () => {
    // The case the avatar cross-check cannot see, and the reason the text
    // signal exists. Derived from in-call-captions.html by DELETION twice
    // over: the caption line's generated class attribute is removed (what a
    // Meet class rotation does), AND the speaker avatar is removed (what a
    // participant with no profile photo renders — initials, not an <img>).
    // Nothing added. The spoken words are still on screen, so an empty
    // result would be a lie about a meeting that was being captioned.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    expect(region).not.toBeNull();
    region?.querySelector(SELECTORS.captionLine)?.removeAttribute("class");
    for (const avatar of region?.querySelectorAll(SELECTORS.captionAvatar) ?? []) avatar.remove();
    // Both halves of the premise: no line matches, and no avatar survives —
    // so the avatar guard alone would return [] here.
    expect(region?.querySelectorAll(SELECTORS.captionLine)).toHaveLength(0);
    expect(region?.querySelectorAll(SELECTORS.captionAvatar)).toHaveLength(0);

    await expect(googleMeetAdapter.readCaptions(pageFor(document))).rejects.toThrow(
      /non-decorative text/i
    );
  });

  it("still returns no cues when a quiet region's only text is its own decorative chrome", async () => {
    // The other side of the same guard, and the one a naive "any text at all"
    // check would get wrong on every quiet meeting. in-call.html, unmodified.
    expect(await googleMeetAdapter.readCaptions(await fixturePage(IN_CALL))).toEqual([]);
  });

  it("throws when a rotated caption class leaves avatars but no visible text", async () => {
    // The shape the TEXT signal cannot see, which is why the avatar check was
    // kept rather than replaced. Derived from in-call-captions.html by
    // deletion: the line's class is removed, and the two text-bearing
    // elements inside the line are removed, leaving the avatar. Nothing
    // added.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    const line = region?.querySelector(SELECTORS.captionLine);
    line?.querySelector(SELECTORS.captionSpeaker)?.remove();
    line?.querySelector(SELECTORS.captionText)?.remove();
    line?.removeAttribute("class");
    expect(region?.querySelectorAll(SELECTORS.captionLine)).toHaveLength(0);
    expect(region?.querySelectorAll(SELECTORS.captionAvatar).length).toBeGreaterThan(0);

    await expect(googleMeetAdapter.readCaptions(pageFor(document))).rejects.toThrow(
      /speaker avatar/i
    );
  });

  it("accounts for every character of the real captured region with its one matched line", async () => {
    // The measurement the residual guard rests on, pinned as the two numbers
    // it actually is. The region's non-decorative text and the single
    // matched line's non-decorative text are the SAME 364 characters, so a
    // healthy read leaves a residual of zero and the guard starts with its
    // whole budget spare.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    const withoutChrome = region?.cloneNode(true) as Element;
    for (const decorative of withoutChrome.querySelectorAll(SELECTORS.captionDecorative)) {
      decorative.remove();
    }
    expect((withoutChrome.textContent ?? "").trim()).toHaveLength(364);

    const line = withoutChrome.querySelector(SELECTORS.captionLine);
    expect((line?.textContent ?? "").trim()).toHaveLength(364);

    for (const matched of withoutChrome.querySelectorAll(SELECTORS.captionLine)) matched.remove();
    expect((withoutChrome.textContent ?? "").trim()).toBe("");
  });

  it("does not cry wolf when the region's own chrome stops being marked decorative", async () => {
    // Derived from in-call-captions.html by DELETING the aria-hidden
    // attribute from the two chrome elements inside the region — the
    // jump-to-latest control's icon ligature and its label. They then count
    // as visible text no caption line accounts for: 28 characters, which is
    // the LARGEST residual any deletion-derived variant of these captures
    // can produce, and the reason the tolerance is 64 rather than zero.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    const chrome = [...(region?.querySelectorAll(SELECTORS.captionDecorative) ?? [])];
    expect(chrome).toHaveLength(2);
    for (const el of chrome) el.removeAttribute("aria-hidden");

    const cues = await googleMeetAdapter.readCaptions(pageFor(document));
    expect(cues).toHaveLength(1);
    expect(cues[0].speaker).toBe("Jordan Rivera");
    expect(28).toBeLessThan(CAPTION_RESIDUAL_TOLERANCE_CHARS);
  });

  it("does not mutate the page while measuring the region's text", async () => {
    // The measurement subtracts decorative subtrees; doing that on the live
    // DOM would delete a real element from a real page as a side effect of a
    // READ, and the second poll would see a page the first one damaged.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    const before = region?.querySelectorAll(SELECTORS.captionDecorative).length;
    expect(before).toBeGreaterThan(0);

    await googleMeetAdapter.readCaptions(pageFor(document));

    expect(region?.querySelectorAll(SELECTORS.captionDecorative)).toHaveLength(before as number);
  });

  it("throws when a caption line carries no speaker element", async () => {
    // Derived from in-call-captions.html by deleting the speaker element.
    // An empty speaker string here would silently cost every utterance in
    // that line its attribution.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    document.querySelector(SELECTORS.captionSpeaker)?.remove();

    await expect(googleMeetAdapter.readCaptions(pageFor(document))).rejects.toThrow(
      /no speaker element/i
    );
  });

  it("throws when a caption line carries no caption text element", async () => {
    // Derived from in-call-captions.html by deleting the text element.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    document.querySelector(SELECTORS.captionText)?.remove();

    await expect(googleMeetAdapter.readCaptions(pageFor(document))).rejects.toThrow(
      /no caption text element/i
    );
  });

  it("keeps a caption line whose text element is present but empty", async () => {
    // The distinction the whole module turns on, applied one level down: an
    // element that exists and holds no text is a real, momentary state (a
    // caption line rendered the instant a speaker starts), not drift. Derived
    // from in-call-captions.html by deleting the text element's children.
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const text = document.querySelector(SELECTORS.captionText);
    expect(text).not.toBeNull();
    if (text) text.textContent = "";

    const cues = await googleMeetAdapter.readCaptions(pageFor(document));
    expect(cues).toHaveLength(1);
    expect(cues[0].speaker).toBe("Jordan Rivera");
    expect(cues[0].text).toBe("");
  });
});

/** A page that returns a caption SCRAPE RESULT directly, bypassing the DOM.
 *
 * `scrapeCaptions` is deliberately split from the decisions taken on its
 * output — its own comment says so: it "reports structure and makes no
 * judgements: every 'is this drift or is this silence' decision is taken on
 * the Node side, in one place, where it can be read and tested". This is that
 * boundary. No markup, no selector and no Meet copy is invented here; the
 * numbers handed over are the ones the real captures were measured to
 * produce, moved by hand to exercise a threshold that a single-caption-line
 * fixture cannot reach by deletion.
 *
 * The partial-rotation case NEEDS this: modelling "some lines matched and
 * some did not" takes at least two caption lines, and the one captured
 * captioned moment holds exactly one. Deleting from it can only ever reduce
 * that to zero. */
function scrapedCaptionsPage(raw: {
  regionPresent: boolean;
  avatarCount: number;
  visibleTextLength: number;
  residualTextLength: number;
  lines: ReadonlyArray<{ speaker: string | null; text: string | null }>;
}): unknown {
  return { evaluate: async () => raw };
}

describe("googleMeetAdapter.readCaptions residual guard", () => {
  const oneRealLine = { speaker: "Jordan Rivera", text: "We decide to ship the readout." };
  /** What that line's two selectors actually READ — the number the coverage
   * check below subtracts from the region's visible text. Every
   * `visibleTextLength` in this block is stated as this plus the residual
   * being modelled, so each case is a shape a real region could hold rather
   * than three numbers that happen to sit next to each other. They were not,
   * before the coverage check existed: nothing read `visibleTextLength`
   * against the lines, so it could be any value at all. */
  const oneRealLineChars = oneRealLine.speaker.length + oneRealLine.text.length;

  it("throws when matched lines leave more text behind than the tolerance allows", async () => {
    // The defect: the drift guard sits inside `lines.length === 0`, so a
    // rotation landing on SOME caption nodes — new nodes carrying a new
    // class while older ones keep the old one, or one of several concurrent
    // lines — never consulted it, and the unmatched lines were dropped in
    // silence. That is the same "quiet meeting" lie the zero-line guard
    // exists to prevent, one tier down.
    await expect(
      googleMeetAdapter.readCaptions(
        scrapedCaptionsPage({
          regionPresent: true,
          avatarCount: 2,
          visibleTextLength: oneRealLineChars + CAPTION_RESIDUAL_TOLERANCE_CHARS + 1,
          residualTextLength: CAPTION_RESIDUAL_TOLERANCE_CHARS + 1,
          lines: [oneRealLine]
        })
      )
    ).rejects.toThrow(/belong\s+to no matched line/i);
  });

  it("names the count and the tolerance in the error, so a reader can judge the drift", async () => {
    await expect(
      googleMeetAdapter.readCaptions(
        scrapedCaptionsPage({
          regionPresent: true,
          avatarCount: 2,
          visibleTextLength: oneRealLineChars + 364,
          residualTextLength: 364,
          lines: [oneRealLine]
        })
      )
    ).rejects.toThrow(new RegExp(`364 character.*tolerance ${CAPTION_RESIDUAL_TOLERANCE_CHARS}`));
  });

  it("allows a residual exactly at the tolerance, so the boundary is not off by one", async () => {
    const cues = await googleMeetAdapter.readCaptions(
      scrapedCaptionsPage({
        regionPresent: true,
        avatarCount: 1,
        visibleTextLength: oneRealLineChars + CAPTION_RESIDUAL_TOLERANCE_CHARS,
        residualTextLength: CAPTION_RESIDUAL_TOLERANCE_CHARS,
        lines: [oneRealLine]
      })
    );
    expect(cues).toHaveLength(1);
  });

  it("does not consult the residual at all when no line matched, leaving that case to its own guard", async () => {
    // A quiet region has no matched lines and no residual either; the two
    // guards must not overlap into one confusing message.
    expect(
      await googleMeetAdapter.readCaptions(
        scrapedCaptionsPage({
          regionPresent: true,
          avatarCount: 0,
          visibleTextLength: 0,
          residualTextLength: 0,
          lines: []
        })
      )
    ).toEqual([]);
  });
});

/** The residual guard above cannot see text INSIDE a matched line: it is
 * measured by removing each matched line's whole subtree and weighing what is
 * left, so anything within a line is subtracted along with it. The per-line
 * guards further down catch a speaker or text element that is MISSING, but an
 * element that is present and empty reads `""`, which is deliberately allowed.
 *
 * Between those two sits a state every existing guard calls healthy: one
 * matched line, zero residual, a real speaker, and an empty text — a cue
 * recording that the speaker said nothing. This is the check that closes it. */
describe("googleMeetAdapter.readCaptions coverage guard", () => {
  const oneRealLine = { speaker: "Jordan Rivera", text: "We decide to ship the readout." };
  const oneRealLineChars = oneRealLine.speaker.length + oneRealLine.text.length;

  it("throws when the region holds speech no matched line's selectors read", async () => {
    await expect(
      googleMeetAdapter.readCaptions(
        scrapedCaptionsPage({
          regionPresent: true,
          avatarCount: 1,
          // Every character is inside the matched line, so the residual is
          // legitimately zero — and the line's own two selectors reach only
          // its speaker. The words are in the region and read by nothing.
          visibleTextLength: oneRealLineChars + CAPTION_RESIDUAL_TOLERANCE_CHARS + 1,
          residualTextLength: 0,
          lines: [{ speaker: oneRealLine.speaker, text: "" }]
        })
      )
    ).rejects.toThrow(/read by\s+no selector/i);
  });

  it("names both numbers and the tolerance, so a reader can judge the drift", async () => {
    await expect(
      googleMeetAdapter.readCaptions(
        scrapedCaptionsPage({
          regionPresent: true,
          avatarCount: 1,
          visibleTextLength: 364,
          residualTextLength: 0,
          lines: [{ speaker: "Jordan Rivera", text: "" }]
        })
      )
    ).rejects.toThrow(
      new RegExp(
        `holds 364 character.*account for\\s+only 13 of them.*` +
          `351 character.*tolerance ${CAPTION_RESIDUAL_TOLERANCE_CHARS}`,
        "s"
      )
    );
  });

  it("allows an uncovered count exactly at the tolerance, so the boundary is not off by one", async () => {
    const cues = await googleMeetAdapter.readCaptions(
      scrapedCaptionsPage({
        regionPresent: true,
        avatarCount: 1,
        visibleTextLength: oneRealLineChars + CAPTION_RESIDUAL_TOLERANCE_CHARS,
        residualTextLength: 0,
        lines: [oneRealLine]
      })
    );
    expect(cues).toHaveLength(1);
  });

  /** The same defect on REAL markup rather than on hand-supplied numbers.
   * MODELLED, and named so: it is the second test in this file that MODIFIES
   * the capture rather than deleting from it, because the state it needs —
   * Meet moving a caption's words into a new child while keeping the line
   * class — has never been captured and cannot be produced by deletion. What
   * is grounded is every number involved: they are the real region's own,
   * measured below before anything is moved. */
  it("throws on a modelled rotation that moves a real caption's words into a new child of its own line", async () => {
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    const line = region?.querySelector(SELECTORS.captionLine);
    const speaker = line?.querySelector(SELECTORS.captionSpeaker);
    const text = line?.querySelector(SELECTORS.captionText);

    // The baseline this fix rests on, verified here rather than trusted: the
    // matched line's speaker and text account for every character the region
    // holds, so a healthy read leaves ZERO uncovered.
    const words = (text?.textContent ?? "").trim();
    expect((speaker?.textContent ?? "").trim()).toHaveLength(13);
    expect(words).toHaveLength(351);
    const withoutChrome = region?.cloneNode(true) as Element;
    for (const decorative of withoutChrome.querySelectorAll(SELECTORS.captionDecorative)) {
      decorative.remove();
    }
    expect((withoutChrome.textContent ?? "").trim()).toHaveLength(364);
    expect(13 + 351).toBe(364);

    // The rotation: the text element stays, and stays EMPTY — which every
    // per-line guard permits — while the words move to a sibling inside the
    // same matched line, where the residual measurement cannot see them.
    const moved = document.createElement("span");
    moved.textContent = words;
    text!.textContent = "";
    line!.appendChild(moved);

    // The premise, asserted so a failure below cannot be the setup: still one
    // matched line, still a non-null speaker and a non-null (empty) text,
    // still zero residual.
    expect(region?.querySelectorAll(SELECTORS.captionLine)).toHaveLength(1);
    expect(line?.querySelector(SELECTORS.captionSpeaker)).not.toBeNull();
    expect((line?.querySelector(SELECTORS.captionText)?.textContent ?? "").trim()).toBe("");
    const afterMove = region?.cloneNode(true) as Element;
    for (const decorative of afterMove.querySelectorAll(SELECTORS.captionDecorative)) {
      decorative.remove();
    }
    for (const matched of afterMove.querySelectorAll(SELECTORS.captionLine)) matched.remove();
    expect((afterMove.textContent ?? "").trim()).toBe("");

    await expect(googleMeetAdapter.readCaptions(pageFor(document))).rejects.toThrow(
      /read by\s+no selector/i
    );
  });

  /** The false-positive direction, on real markup. The coverage check is
   * arithmetic, so it cannot model whatever whitespace the region's own text
   * puts BETWEEN lines — the reason the residual check is measured by
   * deletion instead. MODELLED for the same reason as above: the one captured
   * captioned moment holds exactly one line, so a multi-line region can only
   * be built by cloning that real one. If Meet's region ever did put
   * characters between lines, this is where it shows up. */
  it("does not fire on a modelled multi-line region built from the real caption line", async () => {
    const document = await fixtureDocument(IN_CALL_CAPTIONS);
    const region = document.querySelector(SELECTORS.captionsRegion);
    const line = region?.querySelector(SELECTORS.captionLine);
    line!.parentElement!.appendChild(line!.cloneNode(true));
    expect(region?.querySelectorAll(SELECTORS.captionLine)).toHaveLength(2);

    const cues = await googleMeetAdapter.readCaptions(pageFor(document));
    expect(cues).toHaveLength(2);
    expect(cues.map((cue) => cue.speaker)).toEqual(["Jordan Rivera", "Jordan Rivera"]);
  });

  it("counts a null speaker or text as covering nothing, and still reaches the per-line guard", async () => {
    // A null element is ABSENT, so it reads no characters — but the per-line
    // guards below say what is wrong far more precisely than a character
    // count can, and they must keep doing so rather than being pre-empted by
    // an arithmetic message. Here the region is small enough that coverage
    // has nothing to complain about, and the per-line guard is what fires.
    await expect(
      googleMeetAdapter.readCaptions(
        scrapedCaptionsPage({
          regionPresent: true,
          avatarCount: 1,
          visibleTextLength: oneRealLine.text.length,
          residualTextLength: 0,
          lines: [{ speaker: null, text: oneRealLine.text }]
        })
      )
    ).rejects.toThrow(/no speaker element/i);
  });
});

describe("googleMeetAdapter.readRoster", () => {
  it("reads both participants from the real in-call capture", async () => {
    expect(await googleMeetAdapter.readRoster(await fixturePage(IN_CALL))).toEqual([
      "Jordan Rivera",
      "AI Notetaker"
    ]);
  });

  it("reads the lone self tile from the real lobby capture", async () => {
    // prejoin-waiting.html: knocked, not yet admitted. One tile, ours. This
    // is the evidence that zero tiles is never a legitimate reading.
    expect(await googleMeetAdapter.readRoster(await fixturePage(PREJOIN_WAITING))).toEqual([
      "AI Notetaker"
    ]);
  });

  it("throws when no participant tile is present at all", async () => {
    await expect(googleMeetAdapter.readRoster(await fixturePage(PREJOIN_READY))).rejects.toThrow(
      /participant tile/i
    );
  });

  it("throws when a participant tile carries no name element", async () => {
    // Derived from in-call.html by deleting one tile's name element. A tile
    // that yields "" would put a nameless participant in the roster and in
    // every artifact downstream of it.
    const document = await fixtureDocument(IN_CALL);
    document
      .querySelector(SELECTORS.participantTile)
      ?.querySelector(SELECTORS.participantName)
      ?.remove();

    await expect(googleMeetAdapter.readRoster(pageFor(document))).rejects.toThrow(
      /no name element/i
    );
  });
});

/** A page whose locators resolve against ONE real capture, recording every
 * click and every wait. Enough for the controls this adapter DRIVES (as
 * opposed to the ones it scrapes, which `pageFor` covers). The document is
 * never re-rendered in response to a click — a captured page has no live
 * script behind it, its `<script>` bodies having been emptied by the fixture
 * reduction — so a test asserts on what was CLICKED, never on what Meet
 * would have done next. */
/** Playwright's `:visible` pseudo-class, evaluated against jsdom.
 *
 * jsdom has no layout engine and no `Element.checkVisibility`, so
 * `querySelectorAll` cannot be handed `:visible` at all — it throws on the
 * unknown pseudo-class. This strips the suffix and applies the part of
 * Playwright's definition that a layout-free DOM can answer: an element is
 * not visible if it, or any ancestor, carries the `hidden` attribute or an
 * inline `display: none` / `visibility: hidden`.
 *
 * A STAND-IN, not a reimplementation. Playwright's real rule is "a non-empty
 * bounding box and no visibility:hidden", which needs layout. What this
 * supports is exactly the way a hidden element appears in these captures:
 * `in-call.html` carries `style="display: none;"` on a real Meet container
 * inside the captions region, so the mechanism modelled here is one Meet
 * demonstrably uses. */
function matchesVisible(document: FixtureDocument, selector: string): number {
  const parts = selector.split(/\s*,\s*/);
  const wantsVisible = parts.some((part) => part.endsWith(":visible"));
  const css = parts.map((part) => part.replace(/:visible$/, "")).join(", ");
  const all = [...document.querySelectorAll(css)];
  if (!wantsVisible) return all.length;
  return all.filter((el) => {
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      if (node.hasAttribute("hidden")) return false;
      const style = node.getAttribute("style") ?? "";
      if (/display\s*:\s*none/i.test(style)) return false;
      if (/visibility\s*:\s*hidden/i.test(style)) return false;
    }
    return true;
  }).length;
}

function controlPage(document: FixtureDocument): {
  page: JoinPage;
  clicks: string[];
  waits: number[];
} {
  const clicks: string[] = [];
  const waits: number[] = [];
  const page: JoinPage = {
    async goto() {},
    async innerText() {
      return document.body.textContent ?? "";
    },
    locator(selector: string): JoinLocator {
      const loc: JoinLocator = {
        async count() {
          return document.querySelectorAll(selector).length;
        },
        async click() {
          clicks.push(selector);
        },
        async fill() {},
        first() {
          return loc;
        },
        async getAttribute(name: string) {
          return document.querySelector(selector)?.getAttribute(name) ?? null;
        }
      };
      return loc;
    },
    async waitForTimeout(ms: number) {
      waits.push(ms);
    }
  };
  return { page, clicks, waits };
}

describe("IN_CALL_CONTROLS.captionsToggle", () => {
  it("matches exactly one element in all three in-call captures and none pre-join", async () => {
    // The zero half matters as much here as it does for IN_CALL_ANCHORS, but
    // for a different reason: it is why enabling captions is attempted after
    // admission and never from the lobby.
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS, IN_CALL_CAPTIONS_OFF]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(IN_CALL_CONTROLS.captionsToggle)).toHaveLength(1);
    }
    for (const fixture of [PREJOIN_READY, PREJOIN_WAITING]) {
      const document = await fixtureDocument(fixture);
      expect(document.querySelectorAll(IN_CALL_CONTROLS.captionsToggle)).toHaveLength(0);
    }
  });

  it('reads "Turn on captions" in the real captures-off capture — the label this selector was, until now, never observed matching', async () => {
    // Every claim in google-meet.ts about the OFF state was a generalisation
    // from the camera and microphone toggles, stated as such in that
    // module's comments. This is the first direct observation of it.
    const document = await fixtureDocument(IN_CALL_CAPTIONS_OFF);
    const matched = [...document.querySelectorAll(IN_CALL_CONTROLS.captionsToggle)].map((el) =>
      el.getAttribute("aria-label")
    );
    expect(matched).toEqual(["Turn on captions"]);
    // And unlike the ON captures, only ONE element on the whole page carries
    // "aptions" in an aria-label at all: with the region gone, its own
    // aria-label and the "Jump to most recent captions" button both go with
    // it, so the role="button" clause that disambiguates the toggle from
    // those two in in-call.html has nothing left here to disambiguate from.
    expect(document.querySelectorAll('[aria-label*="aptions"]')).toHaveLength(1);
  });

  it("picks the toggle out of the three elements whose label carries the word", async () => {
    // in-call.html holds three: the captions REGION (role=region), a "Jump to
    // most recent captions" <button> with no explicit role attribute, and the
    // toggle itself. Only the toggle carries role="button", which is the
    // clause that does the work — the same clause, for the same reason, as
    // PRE_JOIN.cameraToggle's.
    const document = await fixtureDocument(IN_CALL);
    const carryTheWord = [...document.querySelectorAll('[aria-label*="aptions"]')].map((el) =>
      el.getAttribute("aria-label")
    );
    expect(carryTheWord).toHaveLength(3);
    const matched = [...document.querySelectorAll(IN_CALL_CONTROLS.captionsToggle)].map((el) =>
      el.getAttribute("aria-label")
    );
    expect(matched).toEqual(["Turn off captions"]);
  });

  it("does not match the singular 'Open caption settings' control", async () => {
    // "aptions" rather than "aption" is what keeps a different control out.
    const document = await fixtureDocument(IN_CALL);
    expect(document.querySelectorAll('[aria-label="Open caption settings"]')).toHaveLength(1);
    const matched = [...document.querySelectorAll(IN_CALL_CONTROLS.captionsToggle)];
    expect(matched.map((el) => el.getAttribute("aria-label"))).not.toContain(
      "Open caption settings"
    );
  });
});

describe("driveToggle against the real captured toggle labels", () => {
  // The convention every toggle in this package depends on — the aria-label
  // states the ACTION, not the state — verified in BOTH directions on the
  // camera toggle, across two captures.
  it("reads 'Turn off camera' as already on, and clicks nothing when asked for on", async () => {
    const { page, clicks } = controlPage(await fixtureDocument(PREJOIN_READY));
    expect(await driveToggle(page, PRE_JOIN.cameraToggle, "on")).toBe("already");
    expect(clicks).toEqual([]);
  });

  it("reads 'Turn on camera' as currently off, and clicks it when asked for on", async () => {
    const { page, clicks } = controlPage(await fixtureDocument(PREJOIN_WAITING));
    expect(await driveToggle(page, PRE_JOIN.cameraToggle, "on")).toBe("clicked");
    expect(clicks).toEqual([PRE_JOIN.cameraToggle]);
  });

  it("reads 'Turn off camera' as clickable when asked for off, and 'Turn on camera' as done", async () => {
    const ready = controlPage(await fixtureDocument(PREJOIN_READY));
    expect(await driveToggle(ready.page, PRE_JOIN.cameraToggle, "off")).toBe("clicked");
    const waiting = controlPage(await fixtureDocument(PREJOIN_WAITING));
    expect(await driveToggle(waiting.page, PRE_JOIN.cameraToggle, "off")).toBe("already");
    expect(waiting.clicks).toEqual([]);
  });

  it("reads 'Turn on captions' as currently off, and clicks it when asked for on — the same convention, on the captions toggle itself, now observed rather than inherited by symmetry", async () => {
    // Until in-call-captions-off.html existed, this direction on THIS
    // control was never captured — only generalised from the camera and
    // microphone toggles above, in the same toolbar. This is the real
    // capture that closes that gap.
    const { page, clicks } = controlPage(await fixtureDocument(IN_CALL_CAPTIONS_OFF));
    expect(await driveToggle(page, IN_CALL_CONTROLS.captionsToggle, "on")).toBe("clicked");
    expect(clicks).toEqual([IN_CALL_CONTROLS.captionsToggle]);
  });
});

describe("driveToggle against a device Meet reports as FAULTED", () => {
  /** `unrecognised` was reasoned about and never measured, and the
   * measurement is in this repository's own fixtures.
   *
   * In `in-call-captions-off.html` the camera selector matches exactly one
   * element and its label is "Camera problem. Show more info" — Meet
   * SUBSTITUTED a device-fault control for the toggle. It satisfies the
   * selector including the `role="button"` clause, so the driver reads it,
   * finds neither "turn on" nor "turn off" in the label, and deliberately
   * does not click.
   *
   * The existing captures cover a host with NO camera, where Meet renders an
   * ordinary readable toggle. They do not cover a host whose device is in a
   * fault state, and that state renders a control this code cannot read. That
   * is what makes `unrecognised` a real branch rather than a defensive one —
   * and on the microphone it is why the join is now refused
   * (`join-driver.test.ts`). */
  const FAULT_LABEL = "Camera problem. Show more info";

  it("finds the real captured fault control under the camera selector, label and all", async () => {
    const document = await fixtureDocument(IN_CALL_CAPTIONS_OFF);
    const matches = document.querySelectorAll(PRE_JOIN.cameraToggle);
    expect(matches).toHaveLength(1);
    expect(matches[0].getAttribute("aria-label")).toBe(FAULT_LABEL);
    // The clause that is doing the work: this is a real `role="button"`, not
    // a device picker the selector happens to reach past.
    expect(matches[0].getAttribute("role")).toBe("button");
  });

  it("reads that control as unrecognised and refuses to click it", async () => {
    const { page, clicks } = controlPage(await fixtureDocument(IN_CALL_CAPTIONS_OFF));
    expect(await driveToggle(page, PRE_JOIN.cameraToggle, "off")).toBe("unrecognised");
    // Blind clicking is the one action that could turn a device ON, so the
    // state that could not be read is the state that must not be touched.
    expect(clicks).toEqual([]);
  });
});

describe("googleMeetAdapter.ensureCaptions", () => {
  it("reports captions already on, without clicking, from both real in-call captures", async () => {
    // Both were captured with captions running — the toggle reads "Turn off
    // captions", which by Meet's convention means they are ON. Clicking it
    // would turn them OFF, which is the failure mode a state-reading (rather
    // than action-reading) implementation would produce on every meeting.
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS]) {
      const { page, clicks } = controlPage(await fixtureDocument(fixture));
      expect(await googleMeetAdapter.ensureCaptions(page)).toBe(true);
      expect(clicks).toEqual([]);
    }
  });

  it("clicks the toggle and reports true from the real captures-off capture — the branch this package could previously only infer", async () => {
    // Before in-call-captions-off.html existed, EVERY fixture-backed test of
    // ensureCaptions ran against a page where captions were already on, so
    // this branch — the one that actually turns captions on for a session
    // that joins muted from them — had never been exercised against real
    // Meet markup at all, only against the generic driveToggle plumbing.
    // This is the primary assertion for that branch now: a real capture,
    // not synthetic markup standing in for one.
    const { page, clicks } = controlPage(await fixtureDocument(IN_CALL_CAPTIONS_OFF));
    expect(await googleMeetAdapter.ensureCaptions(page)).toBe(true);
    expect(clicks).toEqual([IN_CALL_CONTROLS.captionsToggle]);
  });

  it("degrades to false when no captions toggle is on the page, after a bounded wait", async () => {
    // Derived from in-call.html by DELETING the captions toggle: a meeting
    // whose account or host policy offers no captions at all. The answer is
    // false, not a throw and not an infinite wait — the caller records the
    // meeting without attribution.
    const document = await fixtureDocument(IN_CALL);
    document.querySelector(IN_CALL_CONTROLS.captionsToggle)?.remove();
    expect(document.querySelectorAll(IN_CALL_CONTROLS.captionsToggle)).toHaveLength(0);

    const { page, clicks, waits } = controlPage(document);
    expect(await googleMeetAdapter.ensureCaptions(page)).toBe(false);
    expect(clicks).toEqual([]);
    // Retried, because the call-controls bar need not have finished
    // rendering at the instant admission is confirmed — but bounded, so a
    // meeting that will never have captions is not stalled.
    expect(waits).toEqual(
      Array.from({ length: ENSURE_CAPTIONS_ATTEMPTS - 1 }, () => ENSURE_CAPTIONS_POLL_MS)
    );
  });
});

describe("IN_CALL_ANCHORS and IN_MEETING_MARKERS against in-call-captions-off.html", () => {
  // Both sets have a member that IS the captions region, and until this
  // fixture existed that member's captions-off behaviour was reasoned about
  // ("captions are a per-participant feature that can simply be off, in
  // which case the region is absent" — google-meet.ts's own comment) rather
  // than measured. This is the measurement.
  it("scores SELECTORS.captionsRegion 0 and every other anchor 1, so admission still holds on ANY ONE match", async () => {
    const document = await fixtureDocument(IN_CALL_CAPTIONS_OFF);
    const counts = IN_CALL_ANCHORS.map((anchor) => document.querySelectorAll(anchor).length);
    // [aria-label="Meeting details"], [role="region"][aria-label="Call
    // feature notifications and actions"], SELECTORS.captionsRegion — in that
    // order, matching the order IN_CALL_ANCHORS itself declares them.
    expect(counts).toEqual([1, 1, 0]);
    // The anchor set's whole design point: it takes ANY ONE match, so the
    // one member that fails here does not cost admission. Asserted on the
    // real joined selector `join()` actually runs, not just on the counts
    // above in isolation.
    expect(document.querySelectorAll(IN_CALL_ANCHOR_SELECTOR)).toHaveLength(2);
  });

  it("scores the IN_MEETING_MARKERS captions member 0 too, but hasEnded still needs all three gone", async () => {
    const document = await fixtureDocument(IN_CALL_CAPTIONS_OFF);
    const counts = IN_MEETING_MARKERS.map((marker) => document.querySelectorAll(marker).length);
    // captionsRegion, participantTile, leaveCallButton — the same order
    // IN_MEETING_MARKERS declares them in.
    expect(counts).toEqual([0, 1, 1]);
    expect(counts.some((count) => count > 0)).toBe(true);
  });
});

describe("IN_MEETING_MARKERS", () => {
  // The set hasEnded counts, asserted as its own evidence rather than left
  // to be inferred from hasEnded's behaviour. It is NOT IN_CALL_ANCHORS: two
  // of its three members appear in the lobby on purpose, which is exactly
  // what makes it wrong for admission and right for "still attached".
  const expected: ReadonlyArray<{
    readonly marker: string;
    readonly counts: readonly [number, number, number, number];
  }> = [
    { marker: SELECTORS.captionsRegion, counts: [1, 1, 0, 0] },
    { marker: SELECTORS.participantTile, counts: [2, 2, 0, 1] },
    { marker: SELECTORS.leaveCallButton, counts: [1, 1, 0, 1] }
  ];

  it("is exactly the three markers, in the order hasEnded counts them", () => {
    expect(IN_MEETING_MARKERS).toEqual(expected.map((row) => row.marker));
  });

  it.each(expected)(
    "$marker matches $counts across captions/in-call/ready/waiting",
    async ({ marker, counts }) => {
      const measured: number[] = [];
      for (const fixture of [IN_CALL_CAPTIONS, IN_CALL, PREJOIN_READY, PREJOIN_WAITING]) {
        const document = await fixtureDocument(fixture);
        measured.push(document.querySelectorAll(marker).length);
      }
      expect(measured).toEqual([...counts]);
    }
  );

  it("is a DIFFERENT set from IN_CALL_ANCHORS, and two of its members are exactly why", async () => {
    // If these two sets ever became the same list, either admission would
    // start reading the lobby as admitted or hasEnded would call a knocking
    // bot's session over. Pinned as the disagreement itself: the lobby
    // carries some of one set and none of the other.
    const waiting = await fixtureDocument(PREJOIN_WAITING);
    const inLobby = IN_MEETING_MARKERS.filter(
      (marker) => waiting.querySelectorAll(marker).length > 0
    );
    expect(inLobby).toEqual([SELECTORS.participantTile, SELECTORS.leaveCallButton]);
    for (const anchor of IN_CALL_ANCHORS) {
      expect(waiting.querySelectorAll(anchor)).toHaveLength(0);
    }
  });
});

describe("googleMeetAdapter.leave", () => {
  /** Nothing clicked this control until now, and nothing closed the page
   * either — so after every ending the notetaker stayed in the participant
   * list under the display name that is the room's only disclosure that it is
   * there, no longer recording, with no owner left to remove it. */
  it("clicks the real Leave call control in every state that has one", async () => {
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS, IN_CALL_CAPTIONS_OFF, PREJOIN_WAITING]) {
      const { page, clicks } = controlPage(await fixtureDocument(fixture));
      await googleMeetAdapter.leave(page);
      expect(clicks).toEqual([SELECTORS.leaveCallButton]);
    }
  });

  it("stops knocking rather than being left in the lobby", async () => {
    // prejoin-waiting.html carries a Leave control (1 match — the fixture
    // README's selector table). A join that never got past the waiting room
    // is an ending like any other, and it has something to leave.
    const waiting = await fixtureDocument(PREJOIN_WAITING);
    expect(waiting.querySelectorAll(SELECTORS.leaveCallButton)).toHaveLength(1);
  });

  it("treats an absent leave control as already out, not as a fault", async () => {
    // prejoin-ready.html is the only capture with no Leave control, and it is
    // also what a page looks like once the meeting is over — leaveCallButton
    // is an IN_MEETING_MARKERS member, so the commonest ending of all (the
    // room ended it) has already removed the control by the time teardown
    // runs. Throwing here would report a fault on every healthy meeting.
    const { page, clicks } = controlPage(await fixtureDocument(PREJOIN_READY));
    await expect(googleMeetAdapter.leave(page)).resolves.toBeUndefined();
    expect(clicks).toEqual([]);
  });
});

describe("googleMeetAdapter.hasEnded", () => {
  it("reports the meeting as live while any IN_MEETING_MARKERS member is on the page", async () => {
    for (const fixture of [IN_CALL, IN_CALL_CAPTIONS, PREJOIN_WAITING]) {
      expect(await googleMeetAdapter.hasEnded(await fixturePage(fixture))).toBe(false);
    }
  });

  it("reports ended once every IN_MEETING_MARKERS member is gone", async () => {
    // prejoin-ready.html carries none of the three markers: no captions
    // region, no participant tile, no leave-call control.
    expect(await googleMeetAdapter.hasEnded(await fixturePage(PREJOIN_READY))).toBe(true);
  });

  it("survives any two markers disappearing, so a re-render cannot end a live call", async () => {
    // Derived from in-call.html by deleting the captions region and every
    // participant tile. The leave-call control alone still means we are in
    // the call.
    const document = await fixtureDocument(IN_CALL);
    document.querySelector(SELECTORS.captionsRegion)?.remove();
    for (const tile of document.querySelectorAll(SELECTORS.participantTile)) tile.remove();

    expect(await googleMeetAdapter.hasEnded(pageFor(document))).toBe(false);
  });

  it("does not depend on end-of-meeting copy, because none was ever captured", async () => {
    // Pins the reason hasEnded is a negative signal. The plan's reference
    // implementation looked for "You've left the meeting"; that string is in
    // none of the real captures, so nothing here can assert it. If a capture
    // of an ended meeting is ever taken, this test is the marker that
    // hasEnded should be revisited against it rather than left as-is.
    //
    // WHOLE_CORPUS, not ALL_CAPTURES: "no capture holds this copy" is a claim
    // about the corpus, so leaving one capture out of it weakened the claim
    // to exactly the extent of the file it skipped.
    for (const fixture of WHOLE_CORPUS) {
      const document = await fixtureDocument(fixture);
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/left the meeting/i);
    }
  });
});

/** One `.count()` query made against the fake page, with which real capture
 * ("ready" / "waiting" / "inCall") it resolved against. Recorded regardless
 * of which selector was queried — see `scriptedJoinPage`'s doc comment for
 * why that is the point. */
interface CountProbe {
  phase: "ready" | "waiting" | "inCall";
  selector: string;
  count: number;
}

/** Drives `googleMeetAdapter.join` against real captures rather than a
 * single static document. `join` needs both the `evaluate()`-based surface
 * (`hasEnded`, called internally to confirm admission) and the
 * goto/innerText/locator/waitForTimeout surface `joinMeeting` drives — this
 * combines both against ONE mutable current document, so `hasEnded` and the
 * pre-join loop always agree on what page we are "on".
 *
 * `script.onJoinClick` and `script.promoteAfterPolls` model what a real join
 * does: clicking the join control navigates (Meet's own behaviour, not
 * something authored here), and admission arrives some number of polls
 * later. Both transitions land on a REAL capture — never on markup written
 * for the test.
 *
 * Every `.count()` call is recorded in `probes`, tagged with the real
 * capture it was resolved against — NOT with the selector's name. That is
 * deliberate: it lets a test assert "no locator this code queried ever
 * reported a positive count while we were still on prejoin-waiting.html"
 * without asserting which selector `join` used to decide admission. A test
 * that instead re-asserted `IN_CALL_ANCHOR_SELECTOR` by name would
 * pass even if `join`'s wiring pointed at a different, wrong selector — it
 * would only be re-checking the constant, not the wiring that consumes it.
 * A count-based assertion catches that class of regression directly:
 * confirmed by mutating `join`'s admission check to `leaveCallButton` (also
 * present on prejoin-waiting.html) and observing this file's own selector
 * evidence tests still pass while the probe-based assertion below fails. */
function scriptedJoinPage(
  start: FixtureDocument,
  script: {
    onJoinClick?: { document: FixtureDocument; phase: "waiting" | "inCall" };
    promoteAfterPolls?: { count: number; document: FixtureDocument; phase: "inCall" };
    /** Advance vitest's fake clock by the poll interval on every wait, so a
     * test can drive `joinMeeting`'s real waiting-room deadline (which reads
     * `Date.now`) to expiry without a real wait and without a busy loop.
     * Requires `vi.useFakeTimers()`. */
    advanceClockOnWait?: boolean;
  } = {}
): { page: JoinPage; probes: CountProbe[]; textReads: CountProbe["phase"][] } {
  let current = start;
  let phase: CountProbe["phase"] = "ready";
  let clicked = false;
  let pollsSinceClick = 0;
  const probes: CountProbe[] = [];
  /** Which capture each `innerText` read was taken against — i.e. which
   * pages `joinMeeting` fed to `classifyPreJoin`. An "inCall" entry means
   * in-call text was classified. */
  const textReads: CountProbe["phase"][] = [];

  const withGlobalDocument = <R>(fn: () => R): R => {
    (globalThis as unknown as Record<string, unknown>).document = current;
    try {
      return fn();
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).document;
    }
  };

  const page = {
    async goto() {
      // The fake is already "on" `start`; a real navigation has nothing
      // further to do here.
    },
    async innerText(selector: string) {
      if (clicked && script.promoteAfterPolls) {
        if (pollsSinceClick >= script.promoteAfterPolls.count) {
          current = script.promoteAfterPolls.document;
          phase = script.promoteAfterPolls.phase;
        } else {
          pollsSinceClick++;
        }
      }
      textReads.push(phase);
      const el = selector === "body" ? current.body : current.querySelector(selector);
      return el?.textContent ?? "";
    },
    locator(selector: string): JoinLocator {
      const loc: JoinLocator = {
        async count() {
          const count = matchesVisible(current, selector);
          probes.push({ phase, selector, count });
          return count;
        },
        async click() {
          // Only the join control's click is meaningful to this fake: it is
          // the one action that (in real Meet) navigates. Clicking the
          // camera/microphone toggles has no DOM listener left to react to
          // it — their scripts were emptied by the fixture reduction — so
          // there is nothing further to simulate.
          if (selector === PRE_JOIN.joinButton && !clicked) {
            clicked = true;
            if (script.onJoinClick) {
              current = script.onJoinClick.document;
              phase = script.onJoinClick.phase;
            }
          }
        },
        async fill() {
          // Never observed to be called against a real capture — neither
          // pre-join document carries an <input> to fill.
        },
        first() {
          return loc;
        },
        async getAttribute(name: string) {
          return current.querySelector(selector)?.getAttribute(name) ?? null;
        }
      };
      return loc;
    },
    async waitForTimeout(ms: number) {
      // Instant: these tests assert behaviour, not real pacing.
      if (script.advanceClockOnWait === true) vi.advanceTimersByTime(ms);
    },
    async evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R> {
      return withGlobalDocument(() => fn(arg));
    }
  };
  return { page: page as unknown as JoinPage, probes, textReads };
}

describe("googleMeetAdapter.join", () => {
  it("turns the camera and microphone off using the real toggle elements, skips the absent name field, and confirms admission from the real in-call capture — never from the waiting room's own preview tile", async () => {
    const ready = await fixtureDocument(PREJOIN_READY);
    const waiting = await fixtureDocument(PREJOIN_WAITING);
    const inCall = await fixtureDocument(IN_CALL);

    // Sanity per the PRE_JOIN describe block above: both toggles read as
    // currently ON in the ready capture.
    expect(ready.querySelector(PRE_JOIN.cameraToggle)?.getAttribute("aria-label")).toBe(
      "Turn off camera"
    );

    const { page, probes } = scriptedJoinPage(ready, {
      onJoinClick: { document: waiting, phase: "waiting" },
      // Stay on the real waiting-room capture for two polls before Meet
      // admits us — long enough to prove the loop does not mistake
      // prejoin-waiting.html's own preview tile and Leave-call control for
      // admission.
      promoteAfterPolls: { count: 2, document: inCall, phase: "inCall" }
    });

    const outcome = await googleMeetAdapter.join(page, "https://meet.example/x", "AI Notetaker");

    expect(outcome).toBe("admitted");

    // The load-bearing assertion: no query this code made, on ANY selector,
    // ever reported a positive count while still on the real
    // prejoin-waiting.html capture. prejoin-waiting.html genuinely carries a
    // preview tile and a Leave-call control (participantTile: 1,
    // leaveCallButton: 1 — see the fixture README's selector table), so this
    // only holds if admission is decided by something that capture does NOT
    // carry. Selector-name-agnostic on purpose: an assertion phrased against
    // IN_CALL_ANCHOR_SELECTOR by name would still pass even if join's
    // wiring pointed at the wrong (but similarly-named) selector.
    const positiveWhileWaiting = probes.filter((p) => p.phase === "waiting" && p.count > 0);
    expect(positiveWhileWaiting).toEqual([]);
    // And the run actually visited the waiting phase at least once — this
    // guards the guard: an empty `probes` list (e.g. the promotion firing
    // before any query landed) would satisfy the assertion above for the
    // wrong reason.
    expect(probes.some((p) => p.phase === "waiting")).toBe(true);
  });

  it("does not report admitted from a MODELLED in-call page whose anchors are all mounted but hidden", async () => {
    // Important 2. `locator(...).count()` is visibility-blind, so an anchor
    // that is in the DOM and not rendered counted exactly like one a human
    // can see. Meet is a single-page app that mounts and unmounts its own
    // chrome; if it ever preloaded the in-call toolbar behind the lobby,
    // admission would fire from the waiting room and the audio tap — which
    // captures ALL system audio — would start outside a meeting.
    //
    // MODELLED, not captured, and one of the tests in this file that MODIFIES
    // real markup rather than deleting from it. It has to be: the captures
    // show these anchors absent from the pre-join DOM entirely, so no capture
    // of a hidden one can exist. The word is in the test NAME for the same
    // reason every test touching unobserved markup carries `unverified` or
    // `modelled` — a reader scanning results should not have to open the body
    // to learn which assertions rest on a capture and which on a model. What
    // is grounded here is the MECHANISM: in-call.html carries
    // `style="display: none;"` on real Meet containers of its own, asserted
    // below before it is used.
    vi.useFakeTimers();
    const hidden = await fixtureDocument(IN_CALL);
    expect(
      [...hidden.querySelectorAll("[style]")].filter((el) =>
        /display:\s*none/i.test(el.getAttribute("style") ?? "")
      ).length
    ).toBeGreaterThan(0);
    for (const anchor of IN_CALL_ANCHORS) {
      for (const el of hidden.querySelectorAll(anchor)) {
        el.setAttribute("style", "display: none;");
      }
    }
    // The premise: every anchor is still THERE. A visibility-blind count
    // reads the whole set; only a visibility-aware one reads zero.
    expect(hidden.querySelectorAll(IN_CALL_ANCHOR_SELECTOR)).toHaveLength(IN_CALL_ANCHORS.length);

    const { page, textReads } = scriptedJoinPage(await fixtureDocument(PREJOIN_READY), {
      onJoinClick: { document: hidden, phase: "inCall" },
      advanceClockOnWait: true
    });
    await expect(
      googleMeetAdapter.join(page, "https://meet.example/x", "AI Notetaker")
    ).resolves.toBe("waiting_room_timeout");

    // Important 1, on real markup: narrowing admission to RENDERED anchors
    // must not hand this page to classifyPreJoin. It is demonstrably in-call
    // — every anchor is in its DOM — and classifying in-call text is what
    // turns a caption or a chat line reading "you can't join" into a
    // terminal verdict about a meeting we are sitting in. The second,
    // presence-only signal is what keeps the gate shut here while admission
    // stays shut too.
    expect(textReads).not.toContain("inCall");
    expect(textReads).toContain("ready");

    // The positive control, on the SAME capture with the hiding left off —
    // otherwise this would pass for any reason at all that broke admission.
    const shown = await fixtureDocument(IN_CALL);
    const control = scriptedJoinPage(await fixtureDocument(PREJOIN_READY), {
      onJoinClick: { document: shown, phase: "inCall" },
      advanceClockOnWait: true
    });
    await expect(
      googleMeetAdapter.join(control.page, "https://meet.example/x", "AI Notetaker")
    ).resolves.toBe("admitted");
  });

  it("treats a camera toggle absent from the page as nothing to turn off, not an error", async () => {
    // Derived from prejoin-ready.html by DELETION: the camera toggle is
    // removed, modelling a machine where Meet renders no camera control at
    // all — the capture host's own camera hardware was absent, but the
    // control itself was still present. Nothing added; the rest of the
    // document, including the join control and the microphone toggle, is
    // the real capture, unmodified.
    const ready = await fixtureDocument(PREJOIN_READY);
    ready.querySelector(PRE_JOIN.cameraToggle)?.remove();
    expect(ready.querySelectorAll(PRE_JOIN.cameraToggle)).toHaveLength(0);

    const inCall = await fixtureDocument(IN_CALL);
    const { page } = scriptedJoinPage(ready, {
      onJoinClick: { document: inCall, phase: "inCall" }
    });

    await expect(
      googleMeetAdapter.join(page, "https://meet.example/x", "AI Notetaker")
    ).resolves.toBe("admitted");
  });
});

describe("the page contract", () => {
  it("refuses a page that cannot evaluate anything, rather than failing obscurely later", async () => {
    await expect(googleMeetAdapter.readCaptions({})).rejects.toThrow(/evaluate/i);
  });
});

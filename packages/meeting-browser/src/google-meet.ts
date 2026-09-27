import type { CaptionCue, JoinOutcome, PlatformAdapter } from "./types.js";
import type { JoinPage, PreJoinSelectors } from "./join-driver.js";
import { driveToggle, joinMeeting } from "./join-driver.js";

/** Every selector this adapter depends on, in one place, each one read off the
 * real Google Meet captures in `test/fixtures/google-meet/` — never guessed.
 * The fixture README records why that rule exists: the plan this package was
 * built from guessed Meet's waiting-room copy, and neither guessed phrase
 * appears anywhere in real Meet.
 *
 * This is the module most likely to break, and it will break silently unless
 * every read distinguishes "the container is missing" from "the container is
 * empty" — see `readCaptions`. Keeping the selectors together makes the blast
 * radius of a Meet UI change one file.
 *
 * Where a stable attribute exists it is used. Where one does not, the honest
 * answer is that Meet does not offer one and this records that fact rather
 * than dressing a generated class up as something sturdier:
 *
 * - `captionsRegion` — `role` + `aria-label`, both stable, and the exact
 *   label observed. Matched exactly once in `in-call.html` and
 *   `in-call-captions.html`, zero times in either pre-join capture, and zero
 *   times in `in-call-captions-off.html` — an in-call page with captions
 *   genuinely off, which is the measured evidence that the region goes away
 *   with them rather than surviving empty.
 * - `captionLine` / `captionSpeaker` / `captionText` — generated class names.
 *   Nothing inside the captions region carries a `role`, an `aria-*`, or a
 *   `data-*` attribute; these three classes are all the real markup offers.
 *   They are scoped under `captionsRegion` so a collision elsewhere on the
 *   page cannot reach them, and `readCaptions` cross-checks them against
 *   `captionAvatar` so a rotated class fails loudly instead of reading as
 *   silence.
 * - `captionAvatar` — the speaker's profile image inside a caption line.
 *   Deliberately just `img`: it shares no class with the line, so it is an
 *   INDEPENDENT signal that the region holds caption content. Observed once
 *   in `in-call-captions.html`'s region and zero times in `in-call.html`'s.
 *   NOT sufficient on its own, and no longer relied on alone: only ONE
 *   caption sample has ever been captured, one speaker with one profile
 *   photo, and a participant who has no photo renders initials instead of an
 *   `img` — defeating the guard in exactly the case it exists for. See
 *   `captionDecorative`.
 * - `captionDecorative` — `aria-hidden="true"`, the ARIA-standard marker for
 *   content assistive technology must skip. Inside the captions region it is
 *   worn by exactly the two text nodes that are region CHROME rather than
 *   speech: the jump-to-latest button's icon ligature and its own label.
 *   Verified: 2 such elements inside the region in BOTH in-call captures, and
 *   `aria-hidden="false"` appears nowhere in any of the five captures, so
 *   matching the literal `"true"` and matching mere presence are the same
 *   thing here — the literal is used because only `"true"` means hidden. Same
 *   principle as `participantName`'s `:not([aria-hidden])`. Subtracting these
 *   is what makes "the region holds text" a usable drift signal: the region
 *   in `in-call.html` — genuinely quiet, captions on, nobody spoken — is NOT
 *   empty of text, it holds "arrow_downwardJump to bottom", and a naive text
 *   check would throw on every quiet meeting.
 * - `participantTile` — `data-participant-id`, a stable data attribute, on
 *   the video tiles. The roster comes from the tile grid because the people
 *   panel was closed during the capture and so was never observed; a
 *   selector for a panel nobody has seen would be a guess.
 * - `participantName` — the one `span.notranslate` in a tile that is not
 *   `aria-hidden`. `notranslate` is a standard translation-opt-out class
 *   rather than a rotated hash, and every other `notranslate` element in a
 *   tile (icon glyphs, inline SVG wrappers) is `aria-hidden="true"`.
 *   Verified to match exactly once per tile in all four captures that hold
 *   tiles (`in-call.html` and `in-call-captions.html` with two tiles each,
 *   `prejoin-waiting.html` and `in-call-captions-off.html` with one).
 * - `leaveCallButton` — `aria-label`, stable. Present in `in-call.html`,
 *   `in-call-captions.html`, `in-call-captions-off.html` and
 *   `prejoin-waiting.html`; absent from `prejoin-ready.html`. Read by `hasEnded` and CLICKED by `leave`. Both of
 *   those readings are consistent: the states where it is present are exactly
 *   the states there is something to leave.
 */
export const SELECTORS = {
  captionsRegion: '[role="region"][aria-label="Captions"]',
  captionLine: ".nMcdL",
  captionSpeaker: ".NWpY1d",
  captionText: ".ygicle",
  captionAvatar: "img",
  captionDecorative: '[aria-hidden="true"]',
  participantTile: "[data-participant-id]",
  participantName: "span.notranslate:not([aria-hidden])",
  leaveCallButton: '[aria-label="Leave call"]'
} as const;

/** The anchors that answer "is this page the in-call UI?", used by `join` to
 * decide the bot has been ADMITTED. ANY one matching is enough.
 *
 * NOT the same set as `IN_MEETING_MARKERS` further down this file, which is
 * what `hasEnded` counts. That one asks "are we attached to a meeting at
 * all" and two of its three members appear in the LOBBY; this one asks "have
 * we been admitted" and every member of it must be absent there. The two are
 * one word apart in English and opposite in what they permit.
 *
 * A set, rather than the single `[aria-label="Share screen"]` this started
 * as, because that one control is host-CONFIGURABLE: a host who restricts
 * presenting to organizers leaves participants with no share button at all,
 * and the bot would then sit in the meeting reporting `waiting_room_timeout`
 * — indistinguishable from having been denied, on the one signal that decides
 * whether audio capture starts. No single anchor here separates every
 * captured state on its own merits either; the set does, because each member
 * fails for a DIFFERENT reason and admission needs only one survivor.
 *
 * THE ASYMMETRY THAT DECIDES MEMBERSHIP, stated because everything above it
 * reasons in one direction only. Under any-match semantics the members
 * compound in OPPOSITE ways: false negatives need every member to fail at
 * once, so each addition helps a little; a false positive needs only ONE
 * member to fire in a state we are not in, so the WEAKEST member alone sets
 * the false-positive floor. The two errors are not equal either — a false
 * positive starts an all-system-audio capture outside a meeting, which is the
 * harm this whole gate exists to prevent, while a false negative reports
 * `waiting_room_timeout`, a slow and visible failure. So a candidate earns
 * its place only if its marginal false-negative value exceeds what it costs
 * the floor, and "the evidence for it is real" is not that argument.
 *
 * Counts below are `in-call-captions.html` / `in-call.html` /
 * `prejoin-ready.html` / `prejoin-waiting.html`, in that order, each read by
 * parsing the capture. EVERY member is 0 in BOTH pre-join captures — that is
 * the load-bearing half. `prejoin-waiting.html` already carries a participant
 * tile, a Leave-call control and a "Chat with everyone" button (Meet shows a
 * preview and lobby chrome while you knock), so none of those can tell
 * "admitted" apart from "still waiting", and none of them is here.
 *
 * - `[aria-label="Meeting details"]` — VERIFIED 1 / 1 / 0 / 0. The meeting
 *   information button. The most robust member and deliberately listed first:
 *   it is not one of the participant permissions a Meet host can switch off
 *   (those cover screen sharing, chat, reactions, microphone and camera), so
 *   the failure that motivated this whole set cannot reach it. It also sits
 *   OUTSIDE the call-controls toolbar — see the exclusion note below for why
 *   that matters.
 * - `[role="region"][aria-label="Call feature notifications and actions"]` —
 *   VERIFIED 1 / 1 / 0 / 0. An in-call live region, not a toolbar control.
 *   Included because it is a different KIND of element: host permission
 *   toggles hide buttons, and this is not a button. Also outside the
 *   call-controls toolbar.
 * - `SELECTORS.captionsRegion` — VERIFIED 1 / 1 / 0 / 0 (see its own note
 *   above). Fails in a third, independent way: captions are a per-participant
 *   feature that can simply be off, in which case the region is absent —
 *   measured, in `in-call-captions-off.html`. Also outside the toolbar.
 *
 * Measured but NOT adopted, each 1 / 1 / 0 / 0 and each rejected for a stated
 * reason:
 *
 * - `[aria-label="Share screen"]` — DROPPED, having previously been retained
 *   on the grounds that "the evidence for it is real; it is only the sole
 *   reliance on it that was wrong". That is an argument for not depending on
 *   it, not an argument for keeping it, and under the asymmetry above the two
 *   are different questions. It is the weakest member the set had, on both
 *   counts. Its false-positive exposure is the highest: it sits INSIDE
 *   `[role="region"][aria-label="Call controls"]`, and that toolbar is
 *   already rendered POPULATED in `prejoin-waiting.html` — six controls in
 *   the lobby (audio and video settings, both device toggles, More options,
 *   Leave call). Its zero pre-join is therefore a product decision about
 *   which buttons Meet puts in a toolbar it has already drawn, not a
 *   structural boundary, and one more lobby button turns the whole admission
 *   gate into a false positive. Every remaining member sits outside that
 *   container entirely. Its marginal false-negative value is meanwhile nil:
 *   it only helps where all three others fail at once, and the primary anchor
 *   is argued immediately above to be immune to the one host policy that
 *   removes Share screen. Its own note already conceded it "may be absent on
 *   a perfectly healthy join" — a member that is expected to fail in the
 *   cases it exists for, while setting the floor for the error that actually
 *   causes harm.
 * - `[aria-label="Send a reaction"]` — host-configurable, and inside the same
 *   lobby-populated toolbar. Both of Share screen's weaknesses at once.
 * - `[aria-label^="Raise hand"]` — its full label embeds an OS-specific
 *   keyboard shortcut, so the string is not portable across host platforms.
 * - `[aria-label="Meeting tools"]` — an activities panel whose availability
 *   plausibly varies by account tier, which this capture session cannot test.
 *
 * GENERALISATIONS BEYOND THE EVIDENCE, stated plainly. Five captures exist:
 * four from ONE meeting, and a fifth from a second meeting instance taken the
 * same day. Both were hosted by one account under one host policy, in one UI
 * language, on one machine — so the second instance is a data point about
 * stability ACROSS meetings and extends none of the limits below:
 *
 * - "Not host-configurable" is read off Google's documented participant
 *   permissions, NOT off these captures. No capture of a restricted meeting
 *   exists, so the claim that `Meeting details` survives such a policy is
 *   reasoning, not evidence.
 * - Every member matches on ENGLISH copy, so all of them fail together if the
 *   Meet UI renders in another language. That is a shared failure mode the
 *   set does not fix, and no locale-independent in-call-only anchor exists in
 *   these captures to fix it with: every structural container above the
 *   controls (`c-wiz`, `#yDmH0d`, the `jsname`-keyed wrappers) is present in
 *   every captured state, and the `data-*` names that ARE in-call-only
 *   belong to the captions language menu, which is itself captions-dependent.
 * - Absent-from-both-pre-join-captures is not absent-from-every-pre-join
 *   SCREEN. Denied, not-started and expired-session were never captured (see
 *   the fixture README), so no member has been checked against them. A false
 *   positive there would report admission while not in the meeting, which is
 *   why every candidate was required to be 0 in both captures we do have
 *   rather than merely positive in-call.
 */
export const IN_CALL_ANCHORS: readonly string[] = [
  '[aria-label="Meeting details"]',
  '[role="region"][aria-label="Call feature notifications and actions"]',
  SELECTORS.captionsRegion
];

/** The container every member of `IN_CALL_ANCHORS` must stay OUT of.
 *
 * Meet renders this toolbar in the LOBBY, already populated — six controls in
 * `prejoin-waiting.html` — and adds more to it on admission. So an anchor
 * inside it is not distinguishing "admitted" from "waiting" structurally; it
 * is distinguishing them by which buttons Meet currently chooses to put in a
 * toolbar it has already drawn, and one more lobby button silently converts
 * the admission gate into a false positive that starts an all-system-audio
 * capture outside a meeting.
 *
 * Exported because it is a MEMBERSHIP RULE, not a piece of trivia: the test
 * suite asserts every anchor against it, so the reasoning that dropped
 * `[aria-label="Share screen"]` cannot be undone by a future edit that only
 * checks the capture counts. Not used at runtime. */
export const LOBBY_POPULATED_TOOLBAR = '[role="region"][aria-label="Call controls"]';

/** The anchors as one CSS selector list, so a poll costs one page round trip
 * rather than one per anchor. PLAIN CSS, and deliberately kept that way: it
 * is what the fixture tests run through `querySelectorAll`, which is how each
 * anchor's counts stay measurable against the real captures. */
export const IN_CALL_ANCHOR_SELECTOR = IN_CALL_ANCHORS.join(", ");

/** The same anchors, each narrowed to Playwright's `:visible` pseudo-class —
 * and the ONLY form `isAdmitted` is allowed to query.
 *
 * `locator(...).count()` is visibility-blind: it counts an element that is
 * mounted and not rendered exactly as it counts one a human can see. Meet is
 * a single-page app that mounts and unmounts its own chrome, so if it ever
 * preloaded the in-call toolbar behind the lobby, admission would fire from
 * the waiting room and the audio tap — which captures ALL system audio —
 * would start outside a meeting. That is the harm the whole admission gate
 * exists to prevent, and it is the direction this module's own comments
 * already call the more dangerous one.
 *
 * NO capture shows Meet doing that: every anchor is absent from both
 * pre-join captures' DOM entirely, not merely hidden in them. This is
 * therefore a guard against a hypothetical, chosen because the two failure
 * directions are not symmetric — a false positive starts recording a room
 * nobody consented to, while a false negative reports
 * `waiting_room_timeout`, which is a slow visible failure.
 *
 * `:visible` is Playwright's own CSS extension, present in the installed
 * 1.62.1's `customCSSNames` alongside `has-text` and `nth-match`; it is not
 * standard CSS and `document.querySelectorAll` will reject it, which is why
 * the plain list above still exists and is what the fixture evidence tests
 * use.
 *
 * VERIFIED IN PLAYWRIGHT, not only derived. This is the one string gating
 * every admission, and for a while its only assertions were that it
 * string-equals its own derivation and that jsdom rejects it — neither of
 * which says the engine that must parse it accepts a comma-separated list
 * with `:visible` on EACH member. If it threw or resolved to zero,
 * `isAdmitted` would be permanently false and every join would time out.
 * `test/browser/anchor-selectors.test.ts` loads the committed captures in a
 * real Chromium and measures it: accepted, and resolving to one visible
 * element per anchor on both in-call captures, zero on both pre-join
 * captures, and one fewer on `in-call-captions-off.html`. That suite is
 * excluded from the default unit run because it needs a browser binary — see
 * this package's `vitest.config.ts` and README.
 *
 * The cost, now measured rather than stated: Playwright treats a zero-area
 * element as not visible, and
 * `[role="region"][aria-label="Call feature notifications and actions"]` is a
 * live region — the KIND of element commonly rendered zero-size for screen
 * readers. No capture could answer whether Meet's is, because answering it
 * needs layout. In a real Chromium it has a non-zero bounding box and
 * `:visible` matches it, so the member does contribute; that is asserted in
 * the same browser suite, and is the assertion to re-read if Meet ever
 * changes how it renders that region. */
export const IN_CALL_ANCHOR_VISIBLE_SELECTOR = IN_CALL_ANCHORS.map(
  (anchor) => `${anchor}:visible`
).join(", ");

/** Pre-join controls `join` drives. Every value here is either VERIFIED
 * against `prejoin-ready.html`/`prejoin-waiting.html` or marked UNVERIFIED in
 * its own comment.
 *
 * - `cameraToggle` / `micToggle` — `role="button"` PLUS an `aria-label`
 *   containing "amera"/"icrophone" (case pattern matches both "Turn on/off
 *   Camera" and the recapture-safe lowercase form). Deliberately does NOT
 *   match on `aria-label` alone: the device-selector buttons
 *   ("Camera: Camera not found", "Device selection for the camera") also
 *   contain "amera" but carry no explicit `role="button"` attribute, so the
 *   combined selector is what keeps this pointed at the mute toggle and not
 *   the device picker. Verified: exactly 1 match each in both
 *   `prejoin-ready.html` and `prejoin-waiting.html`.
 * - `nameField` — UNVERIFIED. No capture on disk contains a single `<input>`
 *   element, the two pre-join ones included: both were taken signed in to a Google account, and
 *   Meet does not offer a name field to a signed-in participant. Real only
 *   for an anonymous-join flow this capture session never exercised. Missing
 *   is handled as "nothing to fill", never an error — see `join-driver.ts`.
 * - `joinButton` — the FIRST clause is VERIFIED: `prejoin-ready.html`'s join
 *   control's full accessible name is "Ask to join without microphone &
 *   camera" (1 exact match); its *visible* text is the shorter "Ask to join"
 *   (see `PRE_JOIN_MARKERS` in `join-driver.ts`), so this matches on the
 *   `aria-label` substring rather than requiring the whole camera/microphone
 *   suffix, which would break the moment a machine WITH a camera changes the
 *   wording. The second clause, `aria-label="Join now"`, is UNVERIFIED —
 *   never observed in any capture; kept for the direct-entry path (no
 *   waiting room) this capture session's guest account never took.
 */
export const PRE_JOIN: PreJoinSelectors = {
  cameraToggle: '[role="button"][aria-label*="amera"]',
  micToggle: '[role="button"][aria-label*="icrophone"]',
  nameField: 'input[aria-label*="name" i]',
  joinButton: 'button[aria-label*="Ask to join"], button[aria-label="Join now"]'
} as const;

/** The in-call controls this adapter DRIVES, as opposed to the ones it
 * reads. Separate from `PRE_JOIN` because nothing here exists before
 * admission: all five captures agree that the captions toggle is 0 on both
 * pre-join screens and 1 on all three in-call ones, so this cannot be driven
 * from the lobby and is not tried there.
 *
 * - `captionsToggle` — `[role="button"][aria-label*="aptions"]`, VERIFIED
 *   1 / 1 / 0 / 0 / 1 (`in-call-captions.html` / `in-call.html` /
 *   `prejoin-ready.html` / `prejoin-waiting.html` / `in-call-captions-off.html`).
 *   Its label in the first two in-call captures is "Turn off captions", which
 *   by Meet's own convention means captions were ON when they were taken —
 *   the operator switched them on by hand before capturing.
 *
 *   The `role="button"` clause is what earns its keep, exactly as it does for
 *   `PRE_JOIN.cameraToggle`. Three elements in each captions-ON in-call
 *   capture carry "aptions" in an `aria-label`: this toggle, the captions
 *   REGION (`role="region"`), and "Jump to most recent captions" (a
 *   `<button>` with no explicit `role` attribute at all). Only the toggle has
 *   `role="button"`, so the pair of clauses selects exactly one element.
 *   Matching on "aptions" rather than "Captions" keeps it off "Open caption
 *   settings" — singular, and a different control — while surviving a
 *   recapture that changes the leading letter's case. In
 *   `in-call-captions-off.html` the region and the jump control are gone with
 *   the captions, so the toggle is the only element on the page carrying the
 *   word at all and there is nothing left to disambiguate from.
 *
 * VERIFIED IN BOTH DIRECTIONS, and this comment used to say the opposite. It
 * read: the "captions are currently OFF" form of this control, whose label
 * must read "Turn on captions", "appears in NO capture… an in-call capture
 * with them off does not exist", leaving the off state resting on a
 * generalisation from the camera and microphone toggles. That stopped being
 * true when `in-call-captions-off.html` was committed on this same branch:
 * the control is there, its label is exactly `"Turn on captions"`, and two
 * tests assert it (`google-meet.test.ts`, `IN_CALL_CONTROLS.captionsToggle`
 * and `driveToggle against the real captured toggle labels`). The fixtures
 * README said so too — two documents in one commit disagreeing about a
 * value's evidence status is precisely the failure a provenance comment
 * exists to prevent, and this one erred toward scheduling a capture session
 * for a state already captured. */
export const IN_CALL_CONTROLS = {
  captionsToggle: '[role="button"][aria-label*="aptions"]'
} as const;

/** How many times `ensureCaptions` looks for the captions toggle before
 * giving up, and how long it waits between looks.
 *
 * Bounded rather than one-shot because admission is confirmed the instant
 * ONE `IN_CALL_ANCHORS` member appears, and Meet's call-controls bar does not
 * necessarily finish rendering in the same frame. A single miss would cost
 * the meeting its whole attribution, which is a large penalty for having
 * asked a few hundred milliseconds early. Bounded rather than unbounded
 * because a toggle that is genuinely not there — a host or account policy
 * with no captions at all — must degrade promptly to an unattributed
 * transcript instead of stalling the meeting it is supposed to be recording.
 *
 * Five attempts at one second is deliberately shorter than the meeting and
 * far longer than a render; neither number is read off a capture, because a
 * render race cannot be captured. */
export const ENSURE_CAPTIONS_ATTEMPTS = 5;
export const ENSURE_CAPTIONS_POLL_MS = 1000;

/** The DOM surface these scrapers touch, declared here because this package's
 * tsconfig deliberately carries no `DOM` lib: every other module in it runs in
 * Node, and putting `document` in the global type space would let one of them
 * reference a browser API that is not there at runtime. Only the members
 * actually used are declared. */
interface ScrapedElement {
  querySelector(selectors: string): ScrapedElement | null;
  querySelectorAll(selectors: string): ArrayLike<ScrapedElement>;
  getAttribute(name: string): string | null;
  /** Both are needed only to measure the captions region's text WITHOUT its
   * decorative chrome, and are done on a throwaway copy so the live page is
   * never mutated by a read. A real `Element` and jsdom's both satisfy this. */
  cloneNode(deep: boolean): ScrapedElement;
  remove(): void;
  readonly textContent: string | null;
}

interface ScrapedDocument {
  querySelector(selectors: string): ScrapedElement | null;
  querySelectorAll(selectors: string): ArrayLike<ScrapedElement>;
}

declare const document: ScrapedDocument;

/** The minimum a page has to be able to do for this adapter to drive it.
 * Playwright's `Page` satisfies it; so does the fixture-backed stand-in the
 * tests use. */
interface EvaluatablePage {
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>;
}

function evaluatable(page: unknown): EvaluatablePage {
  const candidate = page as Partial<EvaluatablePage> | null | undefined;
  if (typeof candidate?.evaluate !== "function") {
    throw new Error(
      "google-meet: this adapter needs a page with an evaluate() method (a Playwright Page, " +
        "or an equivalent stand-in). Got something without one."
    );
  }
  return candidate as EvaluatablePage;
}

/** The minimum a page has to be able to do for `join` to drive it: navigate,
 * read rendered text, locate and act on elements, and wait between polls. A
 * real Playwright `Page` satisfies both this and `EvaluatablePage` at once;
 * so does a fixture- or string-backed test stand-in built for whichever
 * subset a given test exercises. */
function joinPage(page: unknown): JoinPage {
  const candidate = page as Partial<JoinPage> | null | undefined;
  if (
    typeof candidate?.goto !== "function" ||
    typeof candidate?.innerText !== "function" ||
    typeof candidate?.locator !== "function" ||
    typeof candidate?.waitForTimeout !== "function"
  ) {
    throw new Error(
      "google-meet: join needs a page with goto()/innerText()/locator()/waitForTimeout() " +
        "methods (a Playwright Page, or an equivalent stand-in). Got something without them."
    );
  }
  return candidate as JoinPage;
}

/** `null` means the element was ABSENT; `""` means it was present and held no
 * text. Collapsing the two is the whole bug class this module exists to avoid,
 * so the wire format between page and Node keeps them apart. */
interface RawCaptionLine {
  readonly speaker: string | null;
  readonly text: string | null;
}

interface RawCaptions {
  readonly regionPresent: boolean;
  /** Speaker avatars anywhere in the region. A secondary piece of evidence
   * that the region holds caption content — secondary because it depends on
   * every speaker having a profile photo, which no capture can establish. */
  readonly avatarCount: number;
  /** Characters of NON-decorative text in the region: its whole text content
   * minus every `captionDecorative` subtree. The PRIMARY evidence that the
   * region holds caption content, because it holds regardless of profile
   * photos. A LENGTH rather than the text itself, deliberately: this number
   * ends up in an error message, and the text it measures is what people said
   * in a meeting. */
  readonly visibleTextLength: number;
  /** Characters of non-decorative text in the region that NO matched caption
   * line accounts for: `visibleTextLength` again, minus every matched
   * `captionLine` subtree. Zero on a healthy region — measured at exactly
   * zero on `in-call-captions.html`, whose region and whose single matched
   * line both hold 364 characters.
   *
   * Measured by DELETION rather than by arithmetic on lengths: subtracting
   * summed per-line lengths would have to model whatever whitespace sits
   * between lines in the region's own text, and would be wrong by that
   * amount on every multi-line region.
   *
   * That exactness is bought at a blind spot, which is why it is not the only
   * measurement `readCaptions` takes: removing a matched line removes
   * everything INSIDE it too, so text within a line that no per-line selector
   * reads is subtracted here as if it had been read. `readCaptions` closes
   * that with an arithmetic coverage check against `visibleTextLength`; the
   * two are complementary and neither replaces the other. */
  readonly residualTextLength: number;
  readonly lines: readonly RawCaptionLine[];
}

interface RawParticipant {
  readonly id: string | null;
  readonly name: string | null;
}

/** Runs in the page. Reports structure and makes no judgements: every "is this
 * drift or is this silence" decision is taken on the Node side, in one place,
 * where it can be read and tested. Must stay self-contained — Playwright
 * serialises this function's source into the browser, so it may close over
 * nothing but its argument. */
function scrapeCaptions(sel: typeof SELECTORS): RawCaptions {
  const region = document.querySelector(sel.captionsRegion);
  if (!region) {
    return {
      regionPresent: false,
      avatarCount: 0,
      visibleTextLength: 0,
      residualTextLength: 0,
      lines: []
    };
  }
  const readPart = (line: ScrapedElement, selector: string): string | null => {
    const el = line.querySelector(selector);
    return el === null ? null : (el.textContent ?? "").trim();
  };
  // On a COPY: a read must not mutate the page it is reading. Removing the
  // decorative subtrees is what separates caption text from the region's own
  // chrome — see `captionDecorative` above for why the difference is not
  // cosmetic.
  const copy = region.cloneNode(true);
  for (const decorative of Array.from(copy.querySelectorAll(sel.captionDecorative))) {
    decorative.remove();
  }
  const visibleTextLength = (copy.textContent ?? "").trim().length;
  // Same copy, one step further: take out every line the scraper DID match,
  // and whatever text is left is text no line accounts for.
  for (const matched of Array.from(copy.querySelectorAll(sel.captionLine))) {
    matched.remove();
  }
  return {
    regionPresent: true,
    avatarCount: region.querySelectorAll(sel.captionAvatar).length,
    visibleTextLength,
    residualTextLength: (copy.textContent ?? "").trim().length,
    lines: Array.from(region.querySelectorAll(sel.captionLine)).map((line) => ({
      speaker: readPart(line, sel.captionSpeaker),
      text: readPart(line, sel.captionText)
    }))
  };
}

/** Runs in the page. Same contract as `scrapeCaptions`: structure only. */
function scrapeParticipants(sel: typeof SELECTORS): RawParticipant[] {
  return Array.from(document.querySelectorAll(sel.participantTile)).map((tile) => {
    const nameEl = tile.querySelector(sel.participantName);
    return {
      id: tile.getAttribute("data-participant-id"),
      name: nameEl === null ? null : (nameEl.textContent ?? "").trim()
    };
  });
}

/** The markers that say this page is still ATTACHED TO A MEETING at all —
 * the lobby included. `hasEnded` returns true only once every one of them has
 * gone; see its own comment for why it is a count of what is present rather
 * than a search for end-of-meeting copy.
 *
 * A DIFFERENT set from `IN_CALL_ANCHORS`, and the difference is the whole
 * reason it now has a name of its own. `IN_CALL_ANCHORS` answers "have we
 * been ADMITTED", so every member of it must be absent from the lobby. This
 * set answers "are we still attached to anything", so two of its three
 * members are present in the lobby ON PURPOSE — a bot knocked back out to
 * `prejoin-ready.html` has ended; a bot still knocking has not.
 *
 * Counts are `in-call-captions.html` / `in-call.html` / `prejoin-ready.html`
 * / `prejoin-waiting.html`, read by parsing the captures (the same numbers
 * the fixture README's `SELECTORS` table carries for each value):
 *
 * - `SELECTORS.captionsRegion` — 1 / 1 / 0 / 0. In-call only.
 * - `SELECTORS.participantTile` — 2 / 2 / 0 / 1. IN THE LOBBY: Meet renders
 *   our own preview tile while we knock.
 * - `SELECTORS.leaveCallButton` — 1 / 1 / 0 / 1. IN THE LOBBY too.
 *
 * Four comments across this package used to call these "the three in-call
 * anchors", which read as `IN_CALL_ANCHORS` — a set none of whose members the
 * lobby carries. Naming the set is what stops the two being
 * conflated by a reader who checks one table and applies it to the other. */
export const IN_MEETING_MARKERS: readonly string[] = [
  SELECTORS.captionsRegion,
  SELECTORS.participantTile,
  SELECTORS.leaveCallButton
];

/** Runs in the page. Counts every match of every selector handed to it, and
 * makes no judgement about what the total means — that belongs to `hasEnded`,
 * on the Node side. Takes the selector LIST as its argument rather than
 * closing over `IN_MEETING_MARKERS`: Playwright serialises this function's
 * source into the browser, so it may close over nothing but its argument. */
function countMarkers(markers: readonly string[]): number {
  let total = 0;
  for (const marker of markers) total += document.querySelectorAll(marker).length;
  return total;
}

/** How much non-caption text the captions region may hold before
 * `readCaptions` treats it as speech the scraper failed to read.
 *
 * ONE tolerance, bounding TWO measurements — see `readCaptions` for both.
 * `residualTextLength` is text no matched LINE accounts for; the coverage
 * check is text no matched line's SPEAKER AND TEXT ELEMENTS account for. The
 * second sees inside a line, which the first cannot by construction, and both
 * are answering the same question ("how many characters of speech did we not
 * read"), so one number is the right shape for both. A second knob would be a
 * second thing to tune and a second thing to get wrong.
 *
 * Measured, not chosen by feel. Three numbers bound it, all read off the real
 * captures — and all three re-verified against `in-call-captions.html` when
 * the coverage check was added, which is why they are pinned in the suite
 * rather than only written here:
 *
 * - **0** — the residual on `in-call-captions.html` unmodified. The region's
 *   non-decorative text is 364 characters and the one matched line's is 364.
 *   The guard therefore starts with its whole budget spare on the only
 *   captioned capture that exists. The coverage check reads 0 there too:
 *   speaker (13) plus text (351) is 364, so ZERO characters of that region
 *   are uncovered by the two per-line selectors.
 * - **28** — the largest residual any deletion-derived variant of these
 *   captures can produce: the region's ONLY non-caption text is the
 *   jump-to-latest control's "arrow_downward" (14) and "Jump to bottom"
 *   (14), and both are `aria-hidden="true"`, so they are already subtracted.
 *   28 is what appears if Meet ever stops marking them decorative.
 * - **364** — the one real caption sample, speaker (13) plus words (351).
 *
 * 64 sits above everything ever observed as non-caption text and far below a
 * real utterance. Zero was rejected deliberately: it would fire on every
 * meeting the moment Meet un-hides its own chrome, and a guard that cries
 * wolf on every meeting is switched off by the next person to see it. The
 * cost is stated rather than hidden — a dropped line SHORTER than 64
 * characters ("Yes." plus a speaker name) slips through. That is a real gap,
 * accepted because the alternative is a guard nobody keeps. */
export const CAPTION_RESIDUAL_TOLERANCE_CHARS = 64;

const DRIFT_HINT =
  "The Meet DOM has probably changed. Re-capture the fixtures " +
  "(packages/meeting-browser/test/fixtures/google-meet/README.md) and update SELECTORS.";

export const googleMeetAdapter: PlatformAdapter = {
  id: "google-meet",

  async join(page: unknown, url: string, displayName: string): Promise<JoinOutcome> {
    return joinMeeting(googleMeetAdapter, joinPage(page), url, displayName, {
      selectors: PRE_JOIN,
      // Two anchor queries, deliberately not one. Admission demands a
      // RENDERED anchor, because it is what starts the audio tap; the
      // classification gate settles for a PRESENT one, because what it
      // guards against is turning in-call text into a terminal verdict, and
      // a mounted-but-hidden in-call page must not read as a pre-join screen
      // just because nothing on it is drawn yet.
      isAdmitted: async (p) => (await p.locator(IN_CALL_ANCHOR_VISIBLE_SELECTOR).count()) > 0,
      inCallMarkerPresent: async (p) => (await p.locator(IN_CALL_ANCHOR_SELECTOR).count()) > 0
    });
  },

  async ensureCaptions(page: unknown): Promise<boolean> {
    // Nothing in this package used to turn captions on, and `readCaptions`
    // throws whenever the region is absent — so with captions off, the first
    // tick of every real join killed the session. No capture COULD show
    // that state when this was found: the operator had enabled captions by
    // hand before taking each of the first four, which is exactly why it went
    // unnoticed — every fixture-backed test ran against a page where captions
    // were already on. `in-call-captions-off.html` was captured afterwards and
    // IS that state, so this branch is now driven against real markup rather
    // than reasoned about.
    const p = joinPage(page);
    for (let attempt = 1; ; attempt++) {
      const result = await driveToggle(p, IN_CALL_CONTROLS.captionsToggle, "on");
      // "already" — the label read "Turn off captions", i.e. captions are on
      // and nothing was clicked. "clicked" — it read "Turn on captions" and
      // now they are. Both mean captions are on; the difference matters to
      // nobody but a reader of this comment.
      if (result === "already" || result === "clicked") return true;
      // "unrecognised" is not retried. The element is there and its label
      // says neither "turn on" nor "turn off", so waiting changes nothing
      // and clicking blind would toggle a state we could not read — the one
      // action that could turn captions OFF on a meeting that had them.
      if (result === "unrecognised") return false;
      if (attempt >= ENSURE_CAPTIONS_ATTEMPTS) return false;
      await p.waitForTimeout(ENSURE_CAPTIONS_POLL_MS);
    }
  },

  async readCaptions(page: unknown): Promise<CaptionCue[]> {
    const raw = await evaluatable(page).evaluate(scrapeCaptions, SELECTORS);

    if (!raw.regionPresent) {
      throw new Error(
        `google-meet: captions region not found (${SELECTORS.captionsRegion} matched nothing). ` +
          `Refusing to report an empty transcript as a quiet meeting. ${DRIFT_HINT}`
      );
    }

    if (raw.lines.length === 0) {
      // Two INDEPENDENT reasons to believe the region holds caption content
      // even though no line matched — i.e. that `captionLine`'s generated
      // class rotated, not that the meeting is quiet. Either is enough.
      //
      // Text is primary: a caption is words on screen, so non-decorative text
      // in the region is present for every speaker, with or without a profile
      // photo. Avatars are secondary and kept rather than dropped: they cost
      // one query, they are evidence of a DIFFERENT kind (an element, not a
      // string), and they would still fire on the one shape text cannot
      // see — a region rendering avatars while its text nodes are themselves
      // marked decorative. Neither has ever been observed failing alone,
      // because only one caption sample exists; that is precisely why there
      // are two.
      if (raw.visibleTextLength > 0 || raw.avatarCount > 0) {
        throw new Error(
          `google-meet: the captions region holds caption content — ` +
            `${raw.visibleTextLength} character(s) of non-decorative text and ` +
            `${raw.avatarCount} speaker avatar(s) (${SELECTORS.captionAvatar}) — but no ` +
            `caption line matched ${SELECTORS.captionLine}. Refusing to report a captioned ` +
            `meeting as a quiet one. ${DRIFT_HINT}`
        );
      }
      // Region present, no caption content in it. That IS a quiet moment —
      // observed exactly this way in in-call.html, captured with captions
      // switched on before anyone had spoken. Its region is not textless: it
      // holds the jump-to-latest control, whose text is decorative and is
      // subtracted above.
      return [];
    }

    // Some lines matched. That is NOT the same as every line matching, and
    // the guard above cannot see the difference: it sits inside
    // `lines.length === 0`, so a class rotation that lands on SOME nodes —
    // new caption nodes carrying a new class while older ones keep the old
    // one, or one of several concurrent lines — never consults it. The
    // unmatched lines are simply dropped, which is the same "quiet meeting"
    // lie the zero-line guard exists to prevent, one tier down and silent.
    //
    // So: whatever non-decorative text no matched line accounts for is
    // measured directly, and a significant remainder throws. See
    // `CAPTION_RESIDUAL_TOLERANCE_CHARS` for why the threshold is 64 and not
    // zero.
    if (raw.residualTextLength > CAPTION_RESIDUAL_TOLERANCE_CHARS) {
      throw new Error(
        `google-meet: ${raw.lines.length} caption line(s) matched ${SELECTORS.captionLine}, but ` +
          `${raw.residualTextLength} character(s) of non-decorative text in the region belong ` +
          `to no matched line (tolerance ${CAPTION_RESIDUAL_TOLERANCE_CHARS}). Refusing to ` +
          `drop caption lines the scraper cannot see. ${DRIFT_HINT}`
      );
    }

    // And the same lie one level FURTHER down, which the check above cannot
    // see either. `residualTextLength` is measured by removing every matched
    // line's whole subtree and weighing what is left, so text INSIDE a
    // matched line is invisible to it by construction. The per-line guards
    // below catch a speaker or text element that is MISSING — but an element
    // that is present and empty yields `""`, which is deliberately permitted
    // (a caption line mid-render legitimately holds an empty text node).
    //
    // Combine those two and a rotation that keeps the line class while moving
    // the words into a new child produces: one matched line, zero residual,
    // a non-null speaker, an empty text — every guard green, and the cue
    // records that the speaker said nothing. That is the same "captioned
    // meeting reported as quiet" lie the zero-line guard exists to prevent,
    // one tier down again.
    //
    // So the region's visible text is compared against what the two per-line
    // selectors actually READ. `coveredTextLength` sums each matched line's
    // speaker and text; anything the region holds beyond that is speech no
    // selector reached, wherever it sits.
    //
    // ARITHMETIC here, where the check above is deletion-based, and the two
    // are kept rather than merged for that reason. Deletion is exact but
    // structurally blind inside a line; arithmetic sees inside a line but
    // cannot model whatever whitespace the region's own text puts BETWEEN
    // lines, so it can read a few characters high on a multi-line region.
    // That is what the tolerance absorbs — on the one real captured region
    // the two selectors cover it exactly, 13 + 351 = 364 of 364, so the
    // budget starts entirely spare here too.
    const coveredTextLength = raw.lines.reduce(
      (total, line) => total + (line.speaker?.length ?? 0) + (line.text?.length ?? 0),
      0
    );
    const uncoveredTextLength = raw.visibleTextLength - coveredTextLength;
    if (uncoveredTextLength > CAPTION_RESIDUAL_TOLERANCE_CHARS) {
      throw new Error(
        `google-meet: the captions region holds ${raw.visibleTextLength} character(s) of ` +
          `non-decorative text, but the ${raw.lines.length} matched caption line(s) account for ` +
          `only ${coveredTextLength} of them through ${SELECTORS.captionSpeaker} and ` +
          `${SELECTORS.captionText} — ${uncoveredTextLength} character(s) of speech were read by ` +
          `no selector (tolerance ${CAPTION_RESIDUAL_TOLERANCE_CHARS}). Refusing to report a ` +
          `captioned meeting as a quiet one. ${DRIFT_HINT}`
      );
    }

    const atMs = Date.now();
    return raw.lines.map((line, index) => {
      if (line.speaker === null) {
        throw new Error(
          `google-meet: caption line ${index + 1} has no speaker element ` +
            `(${SELECTORS.captionSpeaker} matched nothing inside it). Refusing to report an ` +
            `unattributed caption as if nobody could be identified. ${DRIFT_HINT}`
        );
      }
      if (line.text === null) {
        throw new Error(
          `google-meet: caption line ${index + 1} has no caption text element ` +
            `(${SELECTORS.captionText} matched nothing inside it). ${DRIFT_HINT}`
        );
      }
      return { speaker: line.speaker, text: line.text, atMs };
    });
  },

  async readRoster(page: unknown): Promise<string[]> {
    const raw = await evaluatable(page).evaluate(scrapeParticipants, SELECTORS);

    if (raw.length === 0) {
      // Unlike captions, zero is never a legitimate reading: a participant
      // always has at least their own tile. prejoin-waiting.html — the lobby,
      // the thinnest in-meeting state there is — still carries one.
      throw new Error(
        `google-meet: no participant tiles found (${SELECTORS.participantTile} matched ` +
          `nothing). A meeting always shows at least our own tile, so an empty roster is ` +
          `drift, not solitude. ${DRIFT_HINT}`
      );
    }

    return raw.map((participant, index) => {
      if (participant.name === null) {
        throw new Error(
          `google-meet: participant tile ${index + 1} (${participant.id ?? "unknown id"}) has ` +
            `no name element (${SELECTORS.participantName} matched nothing inside it). ` +
            `${DRIFT_HINT}`
        );
      }
      return participant.name;
    });
  },

  async leave(page: unknown): Promise<void> {
    // ABSENT is "already out", never an error. `leaveCallButton` is one of
    // `IN_MEETING_MARKERS`, so on the ending this transport meets most often
    // — the room ended the meeting — the control has gone by the time
    // teardown runs, and a throw there would report a fault on every healthy
    // meeting. It is present in the LOBBY too (1 in prejoin-waiting.html), so
    // a join that never got past the waiting room stops knocking here rather
    // than being left behind in it.
    //
    // One click and no confirmation step: no capture of a leave-confirmation
    // dialog exists, and this package's own rule is that a selector nobody has
    // observed is a guess. What makes that safe to leave at one click is that
    // the caller closes the page immediately afterwards, which removes the
    // participant whether or not the click landed — the click is the graceful
    // exit, not the only one.
    const control = joinPage(page).locator(SELECTORS.leaveCallButton).first();
    if ((await control.count()) === 0) return;
    await control.click();
  },

  async hasEnded(page: unknown): Promise<boolean> {
    // Deliberately a NEGATIVE signal. The obvious implementation looks for
    // end-of-meeting copy such as "You've left the meeting" — but no capture
    // of an ended meeting exists (that state cannot be driven on demand and
    // then captured mid-teardown), and that exact string appears in none of
    // the five real captures. Asserting against copy nobody has seen is the
    // mistake the fixture README documents: the plan's guessed waiting-room
    // wording matched no real meeting at all.
    //
    // So this asks the question we CAN answer from evidence — is any
    // `IN_MEETING_MARKERS` member still on the page? Every one of the three
    // must be gone, which makes a transient re-render of any one of them
    // unable to end a live session. Callers should check this BEFORE
    // readCaptions: once the captions region is gone, readCaptions throws by
    // design.
    //
    // Note which set this is: `IN_MEETING_MARKERS`, two of whose members the
    // LOBBY also carries — not `IN_CALL_ANCHORS`, which is the admission set
    // and is deliberately empty pre-join. Reading "not ended" off this set
    // says nothing about having been admitted, which is exactly why
    // `joinMeeting` uses it only as a veto and never as the positive signal.
    const markers = await evaluatable(page).evaluate(countMarkers, IN_MEETING_MARKERS);
    return markers === 0;
  }
};

# Google Meet DOM fixtures

Real Google Meet markup, captured with `scripts/capture-meet-dom.ts`, for the
scrapers in `src/google-meet.ts` (Task 6) to be built and tested against —
never against a DOM anyone here invented.

## Provenance — read before trusting or editing these

**Captured 2026-08-22 from a real Google Meet**, not authored. A human hosted
the meeting from another device; the transport's own account joined as a
**guest** and had to be admitted from the waiting room — the same shape a
production join goes through, not a shortcut available only in a test.

`in-call.html` and `in-call-captions.html` carry **two participants**: the
host and the notetaker. The captions fixture contains real spoken sentences
rendered as live Meet captions, with the speaker's name in the markup — that
speaker-attribution pairing is the evidence the transcript-attribution design
(`src/attribution.ts`, `attributeEvents`) rests on. A hand-authored fixture
could assert that a caption cue carries a speaker name; only a real capture
can show what the container holding both actually looks like.

**A fifth capture, `in-call-captions-off.html`, was added later the same
day** from a separate capture session — a different meeting code from the
one in the other four, so read as a distinct meeting instance, not a second
visit to the same one — with the notetaker account alone in the tile grid
and captions **deliberately left off**: the operator never touched the
captions toggle before capturing. Every earlier state in this directory was
captured with captions already switched on by hand, so this is the one state
none of the other four could show. See "A fifth capture: captions switched
off" below for what it settles.

### What each file is

| File                        | Meeting state                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `prejoin-ready.html`        | The pre-join screen, before joining, camera and microphone already off             |
| `prejoin-waiting.html`      | After asking to join, waiting in the lobby for the host to admit the guest account |
| `in-call.html`              | Admitted, in the meeting, two participants in the roster, captions on, quiet       |
| `in-call-captions.html`     | Same in-call state, captions turned on, after a real sentence was spoken           |
| `in-call-captions-off.html` | Admitted, in the meeting, one participant (the notetaker alone), captions **off**  |

### Two guesses the plan made that real Meet did not match

The plan this package was built from guessed at some of Meet's copy before a
real capture existed. Both guesses were wrong, and the wrongness is the whole
argument for why this task captures markup instead of inventing it:

- **The waiting-room text is `"Please wait until a meeting host brings you
into the call."`** The plan guessed
  `/asking to be let in|waiting for the host/i`. **Neither phrase appears
  anywhere in the real capture.** A classifier built on that guess would have
  matched nothing on every real meeting, and the test suite — asserting
  against the same invented string — would have stayed green while the
  classifier silently failed in production.
- **With camera and microphone already off, the join control reads
  `"Ask to join without microphone & camera"`**, not `"Ask to join"`. A
  classifier or a human reader expecting the shorter phrase would miss this
  one too.

### A DOM detail worth knowing before writing selectors

The camera and microphone toggle buttons' `aria-label`s state the **action**
the button performs, not the current device state: `"Turn off microphone"`
means the microphone is currently **on** (clicking it would turn it off), and
`"Turn on microphone"` means it is currently off. Read the label backwards and
a scraper will report the opposite of the truth.

### A real limit of this capture host

The machine used for this capture session **has no camera** (Meet's own UI
says so — `"Camera not found"` appears in `prejoin-ready.html`). Whatever the
camera control's markup looks like on a machine Meet can actually see a camera
on may differ from what is captured here. Re-capture on a machine with a
camera before trusting camera-specific selectors.

### A fifth capture: captions switched off

`in-call-captions-off.html` closes the one gap the "States not captured"
section below used to call the most important one: every other in-call
capture was taken with captions already switched on by hand, so nothing in
this directory could show what the captions toggle reads, or whether the
captions region even exists, when captions are off. This capture settles
both, measured by parsing the file:

- **Exactly one element's `aria-label` mentions captions at all**
  (`[aria-label*="aptions"]` matches 1, where the ON captures match 3 — the
  toggle, the region, and the "Jump to most recent captions" button, both of
  the latter gone with captions off). That one element is
  `role="button"` and its label is **`"Turn on captions"`** — the exact
  string `IN_CALL_CONTROLS.captionsToggle` and `driveToggle` needed and had
  never observed. It confirms the label-states-the-action convention
  (verified on the camera and microphone toggles) generalises correctly to
  captions too.
- **`[role="region"][aria-label="Captions"]` matches 0.** The captions
  region does not merely hold no lines when captions are off — it is not in
  the DOM at all. This is the load-bearing premise behind `readCaptions`
  throwing rather than returning `[]` when the region is missing: without
  this capture, "throws on a captions-off meeting" was inferred from a
  pre-join page that lacks the region for an unrelated reason
  (`prejoin-ready.html`, never admitted). This capture is admitted — its
  `data-participant-id` tile and `[aria-label="Leave call"]` control both
  match — and the region is still absent, which is the case that actually
  matters.

Captured with only the notetaker account in the tile grid (no second
participant), so `SELECTORS.participantTile` / `participantName` each match 1
here, not 2 — a different roster shape than `in-call.html` and
`in-call-captions.html`, and not itself evidence of anything captions-related.

## Identity substitutions

These fixtures are a real capture and therefore originally carried real
identities. They were replaced consistently, everywhere, before being
committed — substituting the **values only**; no tag, attribute, class name,
id, or ordering was touched, since those are exactly what a scraper parses and
what makes this markup evidence rather than a mockup.

| Found in the capture                                                                                                         | Replaced with                                                                                      | Occurrences (all 4 files) |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- |
| `Jordan Rivera` (the human host's real name)                                                                                 | `Jordan Rivera` (this repo's existing canonical sample identity, used elsewhere in the test suite) | 5                         |
| The notetaker account's display name — this repo's own reserved word, capitalized. Not spelled out here; see the note below. | `AI Notetaker`                                                                                     | 14 (all-caps form)        |
| The same name, spoken aloud mid-sentence and rendered as caption text (mixed case)                                           | `AI Notetaker`                                                                                     | 1                         |
| The notetaker account's email address, which embedded that same reserved word                                                | `notetaker@example.com`                                                                            | 1                         |
| `hsz-evnu-zaj` (the real meeting code)                                                                                       | `abc-defg-hij`                                                                                     | 23                        |

**This document does not spell out that reserved word either** — it is this
repo's own banned word (see the open-source-readiness word-ban gate), so
naming it here would recreate in this README exactly the violation Fix 1
removed from the fixtures. Verified clean with a case-insensitive sweep for it
across all four fixture files (zero remaining) — a lowercase or mixed-case
occurrence buried in an attribute, easy to miss with a case-sensitive check
alone, would still violate the ban.

### `in-call-captions-off.html` — same substitutions, applied separately

Captured in a later session than the four above, so its real identities were
substituted on its own pass rather than folded into the table above — but
using the **same** mapping, reused rather than reinvented:

| Found in the capture                                                                                                            | Replaced with           | Occurrences |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------- |
| The notetaker account's display name (the same reserved word as above, all-caps form)                                           | `AI Notetaker`          | 4           |
| The notetaker account's email address, embedding that same reserved word (lowercase)                                            | `notetaker@example.com` | 1           |
| `gcc-mtng-qkr` (this session's real, ephemeral meeting code — different from the code above; Meet issues a new one per session) | `abc-defg-hij`          | 4           |

No form of the human host's real name (`Jordan Rivera`) appears in this
capture at all — only the notetaker account is present in the roster, so
there was nothing of the host's to replace. Verified clean two ways: the same
case-insensitive sweep for the unspelled reserved word as the other four
(zero remaining), and this repo's own open-source-readiness leakage grep
(`docs/superpowers/plans/2026-07-28-open-source-readiness.md`) run against
this file directly — zero hits.

## Size reduction

The raw captures totalled **11.57 MB**; committed, they are **0.66 MB**. The
reduction is deletion-only — nothing a scraper reads was touched:

- Every `<script>` element's body emptied.
- Every `<style>` element's body emptied.
- Long base64 `data:` URIs (embedded images/fonts) replaced with the literal
  text `data:REMOVED`.

No scraper in this package reads script bodies, style bodies, or the contents
of a `data:` URI — only element structure, attributes, and text content, all
of which survive untouched. Every fixture was checked after reduction to
confirm its key probes (the join control text, the waiting-room text, the
captions container and a caption line, the participant names, the meeting
code) still round-trip. Re-capturing later should reduce the same way rather
than committing raw captures again — a naive re-capture is back to double-digit
megabytes per file.

`in-call-captions-off.html` was captured and reduced the same way, later:
**2.96 MB raw → 0.12 MB committed**, verified after reduction against the
same kind of key probes — the captions toggle's label, the meeting code, the
sole participant's name. Across all five files, raw totals **14.53 MB**;
committed, **0.79 MB**.

## States not captured, and how the design copes

Some pre-join states cannot be produced on demand: a **denied** join, a
meeting that **has not started**, and an **expired session**. None of these
were captured, because none can be reproduced by simply driving a real
meeting through its normal states.

**One in-call state used to be missing for the same reason, and it was the
one that mattered most to `ensureCaptions`: a meeting with captions switched
OFF.** The first four captures were all taken with the operator having
enabled captions by hand beforehand, so none of them could show what the
captions toggle's label reads when they are off, or whether the captions
region survives being switched off. `in-call-captions-off.html` closes this
gap — see "A fifth capture: captions switched off" above for the two
measurements. `ensureCaptions` still reads the toggle's label rather than
probing for the region, and the session still degrades to an unattributed
transcript when no toggle is found at all; what changed is that both of
those design choices now rest on an observed capture instead of a
generalisation from the camera and microphone toggles.

`classifyPreJoin` (Task 7) is designed around that gap: it returns `undefined`
for pre-join text it does not recognize rather than guessing at a
classification, and the join loop treats an unrecognized screen as "keep
waiting" until it times out. An unverified state therefore degrades to a
timeout — a slow, visible failure — never to a confident wrong answer.

## Which selector came from which capture

This is the single audit point for every selector this package ships. **Every
value below was verified by parsing the captures and counting matches** — the
counts here are measurements, not recollections, and the count columns are in
the fixed order `in-call-captions` / `in-call` / `prejoin-ready` /
`prejoin-waiting`, with a fifth `captions-off` column
(`in-call-captions-off.html`) appended where that fixture applies — it is an
in-call state, so it is not added to `PRE_JOIN`'s table. A selector added to
`src/` without a row here is a selector nobody has audited.

### `SELECTORS` — what the scrapers read

| Selector            | Value                                    | captions | in-call | ready | waiting | off | Notes                                                                                             |
| ------------------- | ---------------------------------------- | -------- | ------- | ----- | ------- | --- | ------------------------------------------------------------------------------------------------- |
| `captionsRegion`    | `[role="region"][aria-label="Captions"]` | 1        | 1       | 0     | 0       | 0   | `role` + `aria-label`, both stable                                                                |
| `captionLine`       | `.nMcdL`                                 | 1        | 0       | 0     | 0       | 0   | generated class; scoped under the region                                                          |
| `captionSpeaker`    | `.NWpY1d`                                | 1        | 0       | 0     | 0       | 0   | generated class; 1 per caption line                                                               |
| `captionText`       | `.ygicle`                                | 1        | 0       | 0     | 0       | 0   | generated class; 1 per caption line                                                               |
| `captionAvatar`     | `img`                                    | 7        | 6       | 2     | 3       | 4   | document-wide; **scoped to the region: 1 / 0 / — / — / —**                                        |
| `captionDecorative` | `[aria-hidden="true"]`                   | 229      | 229     | 48    | 46      | 113 | document-wide; **scoped to the region: 2 / 2 / — / — / —**                                        |
| `participantTile`   | `[data-participant-id]`                  | 2        | 2       | 0     | 1       | 1   | stable data attribute; the lobby carries our own preview tile; `off` has one participant, not two |
| `participantName`   | `span.notranslate:not([aria-hidden])`    | 2        | 2       | 0     | 1       | 1   | exactly 1 per tile in every capture that has tiles                                                |
| `leaveCallButton`   | `[aria-label="Leave call"]`              | 1        | 1       | 0     | 1       | 1   | present in the LOBBY too — cannot mean "admitted"                                                 |

The `off` column's `captionAvatar` and `captionDecorative` scoped counts are
`—` for the same reason `ready`/`waiting` are: `SELECTORS.captionsRegion`
matches nothing there, so there is no region to scope a query under.

### `PRE_JOIN` — what `join` drives on the pre-join screen

| Selector       | Value                                                              | captions | in-call | ready | waiting | Verification                                                       |
| -------------- | ------------------------------------------------------------------ | -------- | ------- | ----- | ------- | ------------------------------------------------------------------ |
| `cameraToggle` | `[role="button"][aria-label*="amera"]`                             | 1        | 1       | 1     | 1       | VERIFIED. In `prejoin-ready.html` its label is `"Turn off camera"` |
| `micToggle`    | `[role="button"][aria-label*="icrophone"]`                         | 1        | 1       | 1     | 1       | VERIFIED. Ditto `"Turn off microphone"`                            |
| `nameField`    | `input[aria-label*="name" i]`                                      | 0        | 0       | 0     | 0       | **UNVERIFIED.** No `<input>` exists in ANY capture                 |
| `joinButton`   | `button[aria-label*="Ask to join"], button[aria-label="Join now"]` | 0        | 0       | 1     | 0       | First clause VERIFIED; `"Join now"` **UNVERIFIED**                 |

Three things about those pre-join rows:

- **`cameraToggle` and `micToggle` match in-call too** (1 / 1), and that is
  fine: they are read only before the join click. The clause that earns its
  keep is `role="button"`, which is what keeps them off the device-selector
  buttons — `"Camera: Camera not found"`, `"Device selection for the camera"`
  — which contain the same substring but carry no explicit `role`.
- **`nameField` matches nothing anywhere.** Both pre-join captures were taken
  signed in, and Meet offers a signed-in participant no name field. It is real
  only for an anonymous-join flow this capture session never exercised, and
  `join-driver.ts` treats missing as "nothing to fill", never an error.
- **`joinButton`'s second clause, `aria-label="Join now"`, was never
  observed.** It is kept for the direct-entry path (no waiting room) that this
  session's guest account never took. The first clause is the verified one:
  `prejoin-ready.html`'s control's full accessible name is `"Ask to join
without microphone & camera"`, matched on the substring so a machine WITH a
  camera changing the wording cannot break it.

### `IN_CALL_CONTROLS` — what the adapter DRIVES inside the meeting

Separate from `PRE_JOIN` because nothing here exists before admission.

| Control          | Value                                    | captions | in-call | ready | waiting | off | Verification                         |
| ---------------- | ---------------------------------------- | -------- | ------- | ----- | ------- | --- | ------------------------------------ |
| `captionsToggle` | `[role="button"][aria-label*="aptions"]` | 1        | 1       | 0     | 0       | 1   | VERIFIED both directions — see below |

Three elements in each in-call ON capture carry `aptions` in an `aria-label`:
this toggle, the captions **region** (`role="region"`), and `"Jump to most
recent captions"` — a `<button>` with no explicit `role` attribute at all.
Only the toggle carries `role="button"`, so the pair of clauses selects
exactly one element. That is the same clause, doing the same work, as
`PRE_JOIN.cameraToggle`'s. Matching `aptions` rather than `Captions` keeps it
off `"Open caption settings"` (singular, a different control) while surviving
a recapture that changes the leading letter's case. In the `off` capture
there is only **one** element carrying `aptions` at all — the toggle itself;
the region and the jump-to-latest button are both gone with it — so the
`role="button"` clause has nothing to disambiguate from there, though it is
still needed for the ON captures.

**The captions-OFF state of this control is now VERIFIED, closing a gap the
first four captures left open.** All four of those were taken after the
operator had switched captions on by hand, so the toggle read `"Turn off
captions"` — which by Meet's own convention means captions are currently
**on** — in every one of them; the `"Turn on captions"` form the adapter must
recognise to enable them appeared nowhere. `in-call-captions-off.html`
supplies it directly: its one matching element's `aria-label` is exactly
`"Turn on captions"`. Until this capture, what the OFF state rested on was
the action-label convention in the "DOM detail" section above — verified in
both directions on the camera and microphone toggles, generalised to a third
toggle in the same toolbar rather than observed on it. That generalisation
was correct, and is no longer load-bearing: `driveToggle` against this
toggle now returns `"clicked"` against real captured markup (see
`test/google-meet.test.ts`, `driveToggle against the real captured toggle
labels`).

### `IN_CALL_ANCHORS` — how `join` decides it was ADMITTED

Any one match means admitted. **The pre-join zero columns are the
load-bearing half:** `prejoin-waiting.html` already carries a participant
tile, a Leave-call control and a chat button, so an anchor matching anything
pre-join would report admission from the lobby and start the audio tap
there.

| Anchor                                                                 | captions | in-call | ready | waiting | off | Fails when…                          |
| ---------------------------------------------------------------------- | -------- | ------- | ----- | ------- | --- | ------------------------------------ |
| `[aria-label="Meeting details"]`                                       | 1        | 1       | 0     | 0       | 1   | (not a host-restrictable permission) |
| `[role="region"][aria-label="Call feature notifications and actions"]` | 1        | 1       | 0     | 0       | 1   | (a region, not a button)             |
| `[role="region"][aria-label="Captions"]`                               | 1        | 1       | 0     | 0       | 0   | captions are switched off            |

**The `off` column is this row's failure mode, observed rather than
inferred.** `in-call-captions-off.html` is the first — and only — real
capture where `[role="region"][aria-label="Captions"]` fails while the other
anchors hold, because it is the first capture taken with captions genuinely
off. The set does exactly what it was designed to: either of the other two
still matches, so `IN_CALL_ANCHOR_SELECTOR` resolves to 2 matches here (not
0), and `join()` still reports admitted. See `test/google-meet.test.ts`,
`IN_CALL_ANCHORS and IN_MEETING_MARKERS against in-call-captions-off.html`.

**Every member sits OUTSIDE the call-controls toolbar, and that is a
membership rule rather than a coincidence.** `prejoin-waiting.html` renders
`[role="region"][aria-label="Call controls"]` already **populated** — six
controls in the lobby: audio settings, video settings, both device toggles,
More options and Leave call. So an anchor inside that toolbar scores 0
pre-join only because of which buttons Meet currently chooses to put there,
which is a product decision and not a structural boundary; one more lobby
button turns that anchor into a false positive, and a false positive starts
an all-system-audio capture outside a meeting. Asserted in
`test/google-meet.test.ts`, `places no admission anchor inside the toolbar the
LOBBY already renders populated`.

**The counts above are visibility-blind, and `join` is not.** The admission
query is `IN_CALL_ANCHOR_VISIBLE_SELECTOR` — every anchor above with
Playwright's `:visible` appended — because `locator(...).count()` counts a
mounted-but-unrendered element exactly like a rendered one, and a false
positive there starts the audio tap outside a meeting. No capture shows Meet
preloading in-call chrome behind the lobby: every anchor is **absent
from the pre-join DOM entirely**, not hidden in it. The narrowing is a guard
against a hypothetical, taken because the two failure directions are not
symmetric. It has a cost: Playwright treats a zero-area element as not
visible, and `Call feature notifications and actions` is a live region, the
kind of element commonly rendered zero-size for screen readers. Whether
Meet's is, no capture can say.

This set replaced a **single** selector, `[aria-label="Share screen"]`, and the
reason is the point of the whole table: screen sharing is host-configurable,
so a host who restricts presenting leaves a genuinely admitted bot with no
share control — reporting `waiting_room_timeout` from inside the meeting,
indistinguishable from having been denied, on the one signal that gates
whether audio capture starts.

That control was then kept in the set as one member of four, and has since
been **dropped**. The argument for keeping it was that its evidence was real
and only the sole reliance on it had been wrong — which is an argument for
not depending on it, not an argument for keeping it. Under any-match
semantics the two are different questions: false negatives require every
member to fail at once, so each addition helps a little, while a false
positive needs only **one** member to fire in a state we are not in, so the
weakest member alone sets the false-positive floor. Share screen was the
weakest on both counts. Its false-positive exposure was the highest in the
set (the only member inside the lobby-populated toolbar, above), and its
marginal false-negative value was nil: it helps only where all three other
anchors fail at once, and `Meeting details` is argued to be immune to the one
host policy that removes Share screen.

Measured at 1 / 1 / 0 / 0 and deliberately **not** adopted:
`[aria-label="Share screen"]` (above), `[aria-label="Send a reaction"]`
(host-configurable **and** inside the lobby-populated toolbar — both of Share
screen's weaknesses at once), `[aria-label^="Raise hand"]` (its label embeds
an OS-specific keyboard shortcut), `[aria-label="Meeting tools"]`
(availability plausibly varies by account tier, which this session cannot
test).

**What these counts do NOT establish.** Five captures, two meetings, one
host account, one host policy on each, one UI language, one machine:

- "Not host-configurable" is read off Google's documented participant
  permissions, **not** off these captures. No capture of a restricted meeting
  exists.
- Every anchor matches **English** copy, so all of them fail together in
  another UI language. No locale-independent in-call-only anchor exists in these
  captures to fix that with: every structural ancestor of the controls
  (`c-wiz`, the page root, the `jsname`-keyed wrappers) is present in every
  in-call state, and the `data-*` names that ARE in-call-only belong to the
  captions language menu, which is itself captions-dependent.
- Absent from both pre-join _captures_ is not absent from every pre-join
  _screen_. Denied, not-started and expired-session were never captured, so no
  anchor has been checked against them.
- `in-call-captions-off.html` is a **different meeting instance** from the
  other four (a different meeting code), captured the same day. It adds a
  second data point that the two non-captions anchors are stable across
  meeting instances, but it is still one host account and one machine — it does not
  extend the "not host-configurable" or "one UI language" limits above.

- **The zero columns record which buttons Meet chose to POPULATE, not a
  structural absence.** This is the strongest caveat the evidence here
  supports, and the easiest one to miss: `prejoin-waiting.html` already
  renders the call-controls region itself —
  `[role="region"][aria-label="Call controls"]`, present in the lobby and
  in-call alike — along with most of its chrome. Fifteen `aria-label` values
  are shared between the lobby capture and `in-call.html`: `Call controls`,
  `Chat with everyone`, `Leave call`, `Audio settings`, `Video settings`,
  `More options`, `More options for AI Notetaker`, `Backgrounds and effects`,
  `Reframe`, `Turn on camera`, `Turn on microphone`, `Your call is ending
soon`, `Getting items`, `Side panel` and `Left side panel`. So the toolbar is
  not built on admission; it is already there, and admission merely adds
  buttons to it. An anchor scores 0 in the lobby because Meet did not put
  THAT control in a toolbar it had already drawn — a product decision, not an
  architectural boundary — and a future Meet build that populates one more of
  them pre-join breaks that anchor without anything else changing. The
  pinned counts in `test/google-meet.test.ts` are what would catch it, and
  only against a fresh capture.

### `IN_MEETING_MARKERS` — how `hasEnded` decides we are STILL IN one

A different set from `IN_CALL_ANCHORS` above, and worth reading straight
after it precisely because the two are one word apart in English. That set
answers "have we been **admitted**", so every member must be absent from the
lobby. This one answers "are we attached to a meeting **at all**", so two of
its three members appear in the lobby **on purpose** — a bot still knocking
has not ended; a bot bounced back to `prejoin-ready.html` has. `hasEnded`
returns true only when all three are gone at once.

| Marker                                   | captions | in-call | ready | waiting | off | In the lobby? |
| ---------------------------------------- | -------- | ------- | ----- | ------- | --- | ------------- |
| `[role="region"][aria-label="Captions"]` | 1        | 1       | 0     | 0       | 0   | no            |
| `[data-participant-id]`                  | 2        | 2       | 0     | 1       | 1   | **yes**       |
| `[aria-label="Leave call"]`              | 1        | 1       | 0     | 1       | 1   | **yes**       |

Every value is a member of `SELECTORS` above and carries the same counts
there; this table is the set, not three new selectors. Until 2026-08-22 the
set had no name, and four comments across the package called it "the three
in-call anchors" — which reads as `IN_CALL_ANCHORS`, a set of the same size
with the opposite lobby property. Naming it is what stops a reader checking one
table and applying it to the other.

The `off` column shows `hasEnded` still working correctly with captions off:
one of its three markers is gone, but the other two survive, and all three
would need to be gone at once to read as ended. It is the same real capture,
and the same selector, that settles `IN_CALL_ANCHORS`'s captions-dependent
member above.

### Three things worth stating plainly

Each one is a place where a guess would have been easier than the evidence:

- **The captions region is the only stable anchor captions have.** Nothing
  inside it carries a `role`, an `aria-*` or a `data-*` attribute, so
  `captionLine`, `captionSpeaker` and `captionText` are generated class names
  and will rotate. They are scoped under the region, and `readCaptions`
  cross-checks them against two INDEPENDENT signals — the region's
  non-decorative text length, and `captionAvatar` — so a rotation fails loudly
  instead of reading as a quiet meeting. Text is the primary of the two
  because it does not depend on every speaker having a profile photo; the
  avatar check alone was blind to exactly that case.
- **`captionDecorative` is what makes the text signal usable at all.** The
  captions region in `in-call.html` — genuinely quiet, captions on, nobody yet
  spoken — is **not** empty of text: it holds `"arrow_downwardJump to bottom"`,
  the jump-to-latest control's icon ligature and its label. Both are
  `aria-hidden="true"`. Subtracting every `aria-hidden="true"` subtree leaves
  exactly **0** characters there and **364** in `in-call-captions.html`, which
  is the whole discrimination. A naive "does the region hold text" check would
  throw on every quiet meeting. `aria-hidden="false"` appears **0** times in
  all five captures.
- **The roster is read from the video tiles, not from a people panel**, and is
  one entry per tile. The panel was closed throughout the capture session and
  was never observed; a selector for it would be invention. Whether a
  participant can occupy two tiles at once (main stage plus filmstrip) was not
  observed, so nothing de-duplicates.

## Empty and drifted states are derived by deletion, never authored

Two of the states the scrapers must handle are not separate files:

- **"Captions on, nobody has spoken yet" is `in-call.html`, unmodified.** It
  was captured with captions already running — its toggle reads
  `"Turn off captions"`, and Meet's own live region says `"Live captions are
on"` — and the captions region is present holding **zero** caption lines.
  That is a real quiet moment, captured, so no `no-captions-yet.html`
  reduction was needed or committed.
- **"No captions region and no participant tiles at all" is
  `prejoin-ready.html`, unmodified.** It carries neither container, so it
  serves as the absent-container case without anything being emptied by hand.
  No `empty.html` was committed either — an authored
  `<html><body></body></html>` would be exactly the invented DOM this
  directory exists to avoid.

The remaining states are produced **inside `test/google-meet.test.ts`, by
deleting an element or an attribute from one of these captures at parse
time**. Each such test names the capture it reduces and deletes only; nothing
is added.

**One test breaks that rule, deliberately, and it is the only one.** The
mounted-but-hidden in-call page cannot be derived by deletion from anything
here, because the state being modelled is an anchor that is _present_ and not
rendered — and the captures show these anchors absent from the pre-join DOM
entirely. That test therefore sets `style="display: none;"` on each real
captured anchor. What grounds it is the mechanism rather than the state:
`in-call.html` carries `style="display: none;"` on real Meet containers of
its own, which the test asserts before relying on it. Doing it in the test rather than as a committed file keeps the
derivation visible next to the assertion it supports, and keeps a
quarter-megabyte near-duplicate of a real capture out of the repository.

**Every test that MODIFIES rather than deletes carries `modelled` in its
name**, the same way the tests touching unobserved pre-join copy carry
`unverified`. A reader scanning test output should not have to open the body
to learn which assertions rest on a capture and which on a model — the
modifying rows below are marked MODIFIED for the same reason. The full list,
and what each one models:

| Derived from            | Deleted                                                               | Models                                                      |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `in-call-captions.html` | the caption line's `class` attribute                                  | Meet rotating the generated caption-line class              |
| `in-call-captions.html` | that `class` **and** every `img` in the region                        | the same rotation, for a speaker with **no profile photo**  |
| `in-call-captions.html` | that `class` and the line's speaker + text elements                   | a rotation leaving avatars but no readable text             |
| `in-call-captions.html` | the speaker element                                                   | a caption line that lost its attribution                    |
| `in-call-captions.html` | the caption text element                                              | a caption line that lost its words                          |
| `in-call.html`          | the captions region and every participant tile                        | an in-call page down to one anchor (a re-render)            |
| `in-call-captions.html` | both `aria-hidden` attributes in the region                           | region chrome that stopped being decorative — 28 residual   |
| `in-call.html`          | the two `aria-hidden="true"` elements in the region                   | proof the quiet region's ONLY text is its own chrome        |
| `in-call.html`          | each admission anchor, one at a time                                  | any single anchor failing — admission must still hold       |
| `prejoin-ready.html`    | the camera toggle                                                     | a machine where Meet renders no camera control at all       |
| `in-call.html`          | one tile's name element                                               | a tile that would otherwise yield a nameless participant    |
| `in-call.html`          | the captions toggle                                                   | an account or host policy offering no captions at all       |
| `in-call.html`          | (MODIFIED — `display: none` on every in-call anchor)                  | Meet mounting in-call chrome behind the lobby, unrendered   |
| `in-call-captions.html` | (MODIFIED — the words moved to a new child of their own matched line) | a rotation keeping the line class while relocating its text |
| `in-call-captions.html` | (MODIFIED — the one real caption line cloned in place)                | a multi-line captions region, which one capture cannot hold |

## Limits

**These are a snapshot, not a live contract.** Google ships UI changes to Meet
continuously; nothing here is pinned to a Meet release or guaranteed stable.
A passing test against these fixtures means the scrapers still parse _this
2026-08-22 capture_ — it says nothing about whether they still parse Meet
today. `src/google-meet.ts`'s scrapers throw rather than return an empty
result when an expected container is missing entirely, precisely so that a
future drift between this capture and real Meet markup surfaces as a loud
failure rather than a silently empty transcript. Re-capture and refresh these
fixtures whenever a live run shows that drift.

## Regenerating

1. Follow `docs/profile-setup.md` to open a real, signed-in Chrome window with
   CDP listening on `127.0.0.1:9222`.
2. Drive the meeting by hand into the state you want captured.
3. From the package root:
   ```bash
   node --experimental-strip-types scripts/capture-meet-dom.ts http://127.0.0.1:9222 <name>
   ```
   If more than one page is open in that Chrome window (a leftover sign-in tab
   is a real way this happens — see the script's own header comment), pass a
   substring of the meeting URL as a third argument to pick the right one; the
   script refuses to guess and lists every open page's URL instead. It also
   prints the URL and title of whatever it actually captured, so a wrong
   target is visible immediately rather than discovered later by grepping the
   output file.
4. Re-apply the identity substitutions and size reduction documented above
   before committing.

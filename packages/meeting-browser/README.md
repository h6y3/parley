# @parley/meeting-browser

Joins a video meeting as a named participant in a real, hand-signed-in browser,
listens, and writes the same `MeetingRecord` and `transcript.jsonl` every other
Parley transport writes. It does not speak, and it announces nothing out loud —
see "The display name is the disclosure" below.

Today this means Google Meet (`googleMeetAdapter`). The platform-adapter
interface (`PlatformAdapter` in `src/types.ts`) is deliberately generic so a
future Zoom or Teams adapter can sit behind the same `join`/`ensureCaptions`/
`readCaptions`/`readRoster`/`hasEnded` contract; nothing outside this package
may branch on which platform it is talking to.

## Running it

```bash
pnpm build   # from the repo root — this package is consumed from dist

DEEPGRAM_API_KEY=... PARLEY_POST_CALL_COMMAND=/path/to/hook \
  parley meeting join "https://meet.google.com/abc-defg-hij" \
  --display-name "Notetaker (recording)" \
  --records-path "$HOME/.config/parley/records.jsonl" \
  --audio-device "<your loopback device>"
```

Every flag above has an environment variable beside it
(`PARLEY_MEET_DISPLAY_NAME`, `PARLEY_CALL_RECORDS_PATH`,
`PARLEY_MEET_AUDIO_DEVICE`); run `parley meeting join` with none of them set
and it prints the full usage, including the optional `--cdp-endpoint`,
`--profile-dir`, `--transcripts-dir`, `--ffmpeg-path`, `--max-seconds` and
`--ended-confirm-seconds`.
Before anything is opened, `preflightMeeting` (`src/preflight.ts`) checks every
prerequisite it _can_ check from the machine alone — a reachable CDP endpoint,
a records path and transcripts directory this user can write, an audio device
the capture binary can actually see — and reports every unmet one at once,
each with what to do about it. **What it cannot check is the whole second half
of this document:** preflight passing means the local machine is ready to
attempt a join, not that the join will succeed, that the DOM it is about to
scrape still looks like the DOM it was built against, or that anyone will hear
anything once it does.

Full setup — starting the signed-in Chrome window, understanding the profile
directory as this transport's identity, what an expired session looks like —
is `docs/profile-setup.md`. Read it before the first real run; the summary
below is not a substitute for it.

### What it exits with

For a scheduled notetaker the exit code is the only signal a wrapper reads, so
it distinguishes three outcomes rather than reporting success for all of them:

| Code | Meaning                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| `0`  | Joined, and nothing broke. Captions being off is still `0` — an unattributed transcript is not a failed meeting.        |
| `1`  | An exception, printed by the CLI's own top-level catch. A different event from a meeting that ran badly.                |
| `2`  | The meeting never happened. The record says `never_joined`; `joinOutcome` says which way.                               |
| `3`  | It was in the meeting and something broke. The record and transcript exist and are worth reading — they are incomplete. |

### What it does on the way out

On every ending — the room leaving, the duration ceiling, a capture failure, a
throw while joining — the transport clicks the platform's leave control and
then closes the page it opened. Both, in that order: the click is the graceful
exit the room sees, and closing the page is what actually guarantees departure.
It closes nothing else of yours — not the browser, not the context, not your
other tabs.

This matters more than it sounds. The display name in the participant list is
the room's only disclosure that a notetaker is present (see below), so a
notetaker that stays in the list after it has stopped recording is asserting
something that is no longer true, with no owning process left to remove it.

If leaving fails it is reported as a capture fault on a record that is still
written: failing to get out is not a reason to lose the meeting.

## Operational prerequisites

These are host setup, not code, and nothing in this package can check most of
them for you before a meeting starts. Measured on the intended host:

1. **A virtual audio device.** `brew install blackhole-2ch`. System audio
   output has to be routed to it by hand — macOS has no per-application output
   routing, so **this captures all system audio, not only the browser tab**.
   Run it on a host that makes no other sound while a meeting is in progress.
2. **macOS microphone permission**, for whatever process runs `ffmpeg`. A
   virtual audio device still presents to macOS as an audio _input_, so
   capturing it needs the same permission a real microphone would. Without it,
   `ffmpeg` does not report "permission denied" — it lists **zero** audio
   devices at all and the capture fails with what reads as a plain I/O error.
   If preflight (or a live run) reports no audio devices, check System
   Settings → Privacy & Security → Microphone before suspecting anything else.
3. **A signed-in Chrome profile, started by hand**, exactly as
   `docs/profile-setup.md` describes. This package **attaches** to that window
   over CDP (`chromium.connectOverCDP`) and never **launches** one
   (`chromium.launch`) — a launched Chromium carries automation markers an
   ordinary session does not, and Google's sign-in flow refuses it on sight.
   There is no scripted path around this; the setup document is a document,
   not a script, on purpose.
4. **The display name on that signed-in account is the disclosure.** This
   transport speaks no announcement the way the telephony transport does — the
   name in the participant list is the _only_ way anyone in the room learns a
   notetaker is present. `--display-name` has no default anywhere in this
   package and never will; choosing one on a deployment's behalf would be
   choosing, silently, what the room is told.
5. **`PARLEY_POST_CALL_COMMAND`, set in the environment that launches
   `parley meeting join`.** This transport runs as its own process, not under
   the telephony daemon, so it does not inherit whatever that daemon's
   environment has. Left unset, a meeting still completes and still writes a
   correct record and transcript — and produces no downstream output
   whatsoever, with no error, because an unconfigured hook is a legitimate
   deployment (`dispatchPostCall` returns `null` and nothing throws). If an
   expected message never arrives, check this before anything else. The hook is
   given two minutes and is then SIGKILLed — it runs after the record and the
   transcript are already on disk, and anything longer-running belongs behind
   its own queue rather than on the end of a browser session's teardown.
6. **`DEEPGRAM_API_KEY`**, environment-only and deliberately never a flag —
   argv is readable by every process on the host. Without it `resolveMeetingJoinConfig`
   refuses to start the run at all: no key means no transcription plane, and a
   meeting recorded as silence is worse than a meeting that never started.

## Running the browser suite

Most of this package's tests are pure Node, with jsdom parsing the committed
captures. **One file is not**: `test/browser/anchor-selectors.test.ts` drives a
real Chromium through Playwright, because
`IN_CALL_ANCHOR_VISIBLE_SELECTOR` — the single query that decides whether the
bot has been admitted, and therefore whether an all-system-audio capture
starts — is written in Playwright's own CSS dialect, which jsdom cannot parse
at all. Its only assertions used to be that it string-equals its own
derivation and that jsdom rejects it. If Playwright ever rejected it or
resolved it to zero, `isAdmitted` would be permanently false and **every join
would time out**, and nothing in the suite would have said so.

It is excluded from `pnpm run test` because it needs a browser binary — a
~180 MB download that a fresh clone should not acquire silently. Run it
explicitly:

```bash
pnpm --filter @parley/meeting-browser exec playwright install chromium
pnpm --filter @parley/meeting-browser run test:browser
```

The exclusion is a separate vitest config rather than a skip guard inside the
file, deliberately: a guarded test reports as passing-or-skipped depending on
an environment variable nobody sets, which is how a suite ends up claiming
coverage it does not have. Excluded by config, the browser suite either runs
and asserts, or is visibly not part of the command you ran.

It also settles one thing no static capture could: `:visible` needs layout, and
in a real Chromium the `Call feature notifications and actions` live region has
a non-zero bounding box, so that anchor does contribute rather than silently
dropping out of the set.

## What the test suite cannot prove

Every test in this package runs against hand-authored fake pages, five real
but _static_ DOM captures (`test/fixtures/google-meet/`, one meeting, one host
account, one UI language, one machine — see that directory's own README for
the full accounting of what those captures do and do not establish), and fake
child processes standing in for `ffmpeg` and the transcription socket. That
combination is enough to prove the code does what it says against the
evidence it has. It is not evidence about the following, and nothing short of
a real meeting is:

1. **Whether Google Meet admits the bot at all**, in a meeting the operator
   does not host. The waiting-room and admission flow is exercised here only
   against captures of one guest join that _did_ get admitted. A host who
   never responds, a meeting that requires a passcode, an organization policy
   that blocks external guests entirely — none of these have ever been
   observed, captured, or driven in a test.
2. **Whether the selectors in `SELECTORS`, `PRE_JOIN`, `IN_CALL_CONTROLS`,
   `IN_CALL_ANCHORS` and `IN_MEETING_MARKERS` (`src/google-meet.ts`) still
   match the live DOM.** Several of them are Google's own _generated_ class
   names — `.nMcdL`, `.NWpY1d`, `.ygicle`, the three selectors `readCaptions`
   depends on for every caption line's container, speaker and text — and
   generated class names rotate on Google's schedule, not this repository's.
   A passing test suite proves these strings matched the DOM on the day the
   fixtures were captured. It says nothing about matching it today.
3. **Whether audio genuinely flows from the meeting into a transcript.**
   `test/audio-tap.test.ts` proves the capture module correctly wraps
   whatever `ffmpeg` produces; it does not run `ffmpeg`, open a real
   `avfoundation` device, or hear anything. The first evidence that this
   package can turn a real conversation into real transcript text is the
   first meeting where it does.
4. **Whether speaker attribution actually lands.** `attributeEvents`
   (`src/attribution.ts`) matches a transcript event to a caption cue only
   when they fall within `ALIGN_WINDOW_MS` (3 seconds) of each other, and its
   own tests construct events and cues with timestamps chosen to land inside
   or outside that window on purpose. Whether Meet's caption latency and
   Deepgram's transcription latency actually land two independent,
   real-world clocks that close together — against a session clock whose two
   halves start at different instants (`createMeetingSession`'s `sessionT0`
   versus the tap's own start, `src/run.ts`) — is a timing question a fake
   clock cannot answer. A transcript with correct words and wrong, or absent,
   speakers is a plausible first-run outcome this suite would not catch.
5. **The states no capture covers.** A denied join, a meeting that has not
   started, and an expired session (`auth_required`) each have a
   `JoinOutcome` and a regex in `classifyPreJoin`'s `PRE_JOIN_MARKERS`
   (`src/join-driver.ts`) — and every one of those three regexes is marked
   `UNVERIFIED` in that file's own comments, because none of the three states
   can be produced on demand by simply driving a real meeting through its
   normal flow. Until one of them happens for real, "the code has a case for
   this" and "the code correctly recognises this" are different claims, and
   only the first one has evidence behind it.

A green suite here has been wrong before, on this exact branch, in three
different ways worth naming plainly rather than gesturing at: the telephony
transport's own post-call hook (`src/post-call.ts`'s doc comment records it)
shipped a version that exited 127 and reported nothing anywhere, found only
by placing a real call weeks later; the plan this package was built from
guessed Google's waiting-room copy, and neither invented phrase appeared
anywhere in a real Meet capture; the same plan also guessed the join
control's text as the short "Ask to join" and missed that its full
accessible name is "Ask to join without microphone & camera" (see the
fixtures README's "Two guesses the plan made that real Meet did not match");
and nothing in this package turned Meet's captions on until that gap was
found and closed (`src/session.ts`'s comment on the point: "on a real
meeting the first `readCaptions` would have found no region and thrown") —
every fixture-backed test up to that point ran against a capture whose
captions an operator had already switched on by hand, so the suite stayed
green while a real join would have died on its first tick. None of the
roughly twelve hundred tests in this repository's suite caught any of the
three. That is not a reason to distrust the suite generally — it is why this
section exists instead of a green checkmark standing in for it.

## Known limits

- **`classifyPreJoin`'s patterns match English UI copy only, and this is the
  worse of the two locale limits** (`PRE_JOIN_MARKERS`, `src/join-driver.ts`).
  `/ask to join/i` is what recognises the ready screen, and recognising it is
  the only thing that clicks the join control — so on a Meet UI in another
  language nothing matches, the control is never pressed, and the run times
  out **having never knocked**. The room never saw a notetaker and the host
  was never asked to admit anything, yet the outcome reads the same as an
  anchor failure, where the bot is very possibly sitting in the meeting. One
  question separates them: ask the host whether a participant asked to be let
  in. If somebody knocked, suspect the anchors below; if nobody did, suspect
  the classifier. The fix for either is a re-capture in that locale and
  locale-aware patterns, never a longer timeout.
- **Every `IN_CALL_ANCHORS` member matches English UI copy only** —
  `"Meeting details"`, `"Call feature notifications and actions"`, and the
  captions region's own `aria-label` — so all of them fail together the moment Meet renders in
  another locale, and `join-driver.ts`'s
  own comment on the point is where that failure actually surfaces: a
  `waiting_room_timeout` that is, in a non-English UI, indistinguishable from
  a completely successful join. No locale-independent in-call-only anchor
  exists in the captures this package was built from — every structural
  ancestor of the controls is present pre-join too, and the `data-*` names
  that are in-call-only belong to the captions language menu, which is
  itself captions-dependent. The fix is a re-capture in that locale and a
  locale-aware anchor set, not a longer timeout.
- **Three caption selectors are Google's generated class names and will
  rotate**: `SELECTORS.captionLine`, `SELECTORS.captionSpeaker` and
  `SELECTORS.captionText` (`src/google-meet.ts`). `readCaptions` is written to fail loudly rather
  than silently when that happens — see the module's own extensive comments
  on cross-checking a rotation against the region's non-decorative text
  length and its avatar count — but a loud failure is still a failure, and
  the rotation itself is out of this repository's control.
- **A partial class rotation** (some caption lines match, others land on a
  changed class and are silently dropped), **a rotation that keeps the line
  class while moving the words inside it** (every per-line guard green, and
  the cue records that the speaker said nothing), **and a host who restricts
  screen sharing** (removing one of the `IN_CALL_ANCHORS` members on an
  otherwise perfectly healthy join) are all reasoned about at length in
  `src/google-meet.ts`'s own comments, next to the code that handles each —
  see `CAPTION_RESIDUAL_TOLERANCE_CHARS` for the first two, which it bounds as
  two complementary measurements (text no matched line accounts for, and text
  no matched line's own speaker/text selectors read), and the `IN_CALL_ANCHORS`
  doc comment for the third. That reasoning is not repeated here.

For the full audit of which selector was verified against which real capture,
with the exact match counts, see
`test/fixtures/google-meet/README.md`.

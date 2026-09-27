# Setting up the Chrome profile for the browser meeting transport

The browser meeting transport joins a video meeting under a signed-in Google
account. Getting that account signed in is a **manual, one-time procedure**
you run by hand — deliberately not a script. Read the next section before
running anything.

## Why this is a document, not a script

Google blocks sign-in attempts from automated browsers with _"This browser or
app may not be secure."_ A browser Playwright **launches**
(`chromium.launch()`) carries automation markers — `navigator.webdriver` and
related fingerprint signals a launched Chromium exposes that an ordinary user
session does not — and Google's sign-in flow refuses it. A browser the
**operator** starts by hand, which Playwright later **attaches to over CDP**
(`chromium.connectOverCDP`), carries none of those markers: it is an ordinary
Chrome window that something is merely watching, not driving.

That distinction is the entire reason this is a document instead of a script.
**Do not write a script that launches Chrome and signs in** — it will hit the
same block a launched browser always does, no matter how convincingly it
imitates a human typing. If your instinct on reading this is "let's automate
the setup too," that instinct is exactly what this procedure exists to head
off.

## One-time setup

Run this once, by hand, in a terminal, on macOS (verified against a real
Chrome-stable install — this is the standard app bundle path):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.config/parley/meet-profile" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check
```

This opens a new Chrome window on its own empty profile
(`~/.config/parley/meet-profile`) with the DevTools protocol listening on
`127.0.0.1:9222`. Nothing in this command signs in to anything or joins any
meeting — it only opens a window.

In that window, sign in to the account you want the transport to use, exactly
as a human would: type the address, type the password, answer whatever
verification Google asks for. **If a passkey prompt, an MFA challenge, or a
"verify it's you" screen appears, answer it yourself, in that window.** No
automation should attempt any of it — that is the human step this whole
procedure exists to preserve.

Leave the window open. Everything that follows — `scripts/capture-meet-dom.ts`
now, the real meeting adapter later — attaches to `http://127.0.0.1:9222`
rather than launching anything of its own. Don't close the window between
sessions: the point of `--user-data-dir` is that the signed-in session
persists in that directory across runs, so you do this once, not every time.

## What this profile directory is

`$HOME/.config/parley/meet-profile` (or wherever `--user-data-dir` points)
**is the transport's identity.** There is no separate credential the code
holds anywhere — a signed-in session sitting in this directory _is_ the
credential the browser transport authenticates with. `chromeProfileDir` on
`BrowserMeetingConfig` (`@parley/meeting-browser`) names this same directory.
Treat it as durable state, not a throwaway: back it up if you don't want to
repeat this procedure, and never point two transports that need to present as
different accounts at the same directory.

## The display name is the disclosure

Google Meet shows the signed-in account's display name to every other
participant in the room. This transport has no spoken announcement the way a
phone call does — **the display name on the account you sign in with here is
the entire disclosure that a bot joined the meeting.** Choose an account and a
display name that say so plainly. This is not a cosmetic choice; it is the
disclosure this transport relies on in place of speaking one.

## An expired session isn't a mystery — it's `auth_required`

Google sessions expire. When the transport attaches to a profile whose session
has lapsed, the join attempt does not fail with an opaque timeout or a page
full of DOM nothing recognizes — it resolves to the `auth_required` join
outcome (`JOIN_OUTCOMES`, `@parley/core`), and the meeting record reflects
that plainly rather than being mis-classified as, say, a waiting-room timeout.
If a real run comes back `auth_required`, the fix is this procedure again:
open the profile's Chrome window (or repeat the launch command above against
the same `--user-data-dir`) and sign in by hand once more.

## Joining a meeting

Once that window is open and signed in, one command joins a meeting, captures
its audio, transcribes it, writes a record plus a transcript, and hands the
result to the post-call hook:

```bash
DEEPGRAM_API_KEY=... parley meeting join "https://meet.google.com/abc-defg-hij" \
  --display-name "Notetaker (recording)" \
  --records-path "$HOME/.config/parley/records.jsonl" \
  --audio-device "<your loopback device>"
```

Every one of those has an environment variable instead
(`PARLEY_MEET_DISPLAY_NAME`, `PARLEY_CALL_RECORDS_PATH`,
`PARLEY_MEET_AUDIO_DEVICE`), and `parley meeting join` with none of them prints
the full list. The CDP endpoint and the profile directory default to the ones
this document told you to use; `--cdp-endpoint` and `--profile-dir` override
them.

**`--display-name` has no default and never will.** It is what the participant
list shows, and this transport speaks no announcement — so that name is the
entire disclosure to the room. See "The display name is the disclosure" above.

`--audio-device` is the **loopback** device the meeting's audio is routed to,
named exactly as the capture binary lists it. A microphone would capture the
room the machine is sitting in rather than the call. To see what is available:

```bash
ffmpeg -f avfoundation -list_devices true -i ""
```

The command checks all of this before it opens anything — an unreachable
DevTools endpoint, a device that is not there, a records path it cannot write —
and reports every unmet prerequisite at once, with what to do about each.

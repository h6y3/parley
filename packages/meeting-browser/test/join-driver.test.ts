import { describe, expect, it } from "vitest";
import type { JoinLocator, JoinPage, PreJoinSelectors } from "../src/join-driver.js";
import {
  DEFAULT_ENDED_POLL_MS,
  DeviceStateUnknownError,
  HAS_ENDED_CONFIRM_MS,
  classifyPreJoin,
  confirmPollsForWindow,
  driveToggle,
  joinMeeting,
  waitUntilMeetingEnded
} from "../src/join-driver.js";
import { CAPTION_POLL_MS } from "../src/session.js";

describe("classifyPreJoin", () => {
  // VERIFIED: read directly off the real captures in
  // test/fixtures/google-meet/. See join-driver.ts's PRE_JOIN_MARKERS for
  // the exact provenance of each phrase.
  const verified: Array<[string, string, string]> = [
    ["Ask to join", "admitted", "prejoin-ready.html: the join control's visible text"],
    [
      "Ask to join without microphone & camera",
      "admitted",
      "prejoin-ready.html: the join control's full aria-label"
    ],
    [
      "Please wait until a meeting host brings you into the call",
      "waiting_room_timeout",
      "prejoin-waiting.html: the lobby status text"
    ]
  ];
  for (const [text, expected, source] of verified) {
    it(`classifies ${JSON.stringify(text)} as ${expected} (verified: ${source})`, () => {
      expect(classifyPreJoin(text)).toBe(expected);
    });
  }

  // UNVERIFIED: a denied join, a meeting that has not started, an expired
  // session, and the direct-entry ("Join now") path could not be produced on
  // demand during the capture session, so no real markup or copy exists to
  // check any of these against. Best-known phrasing only — see the fixture
  // README's "States not captured" section.
  const unverified: Array<[string, string]> = [
    ["Join now", "admitted"],
    ["Someone in the meeting denied your request to join", "denied"],
    ["You can't join this call", "denied"],
    ["The meeting hasn't started", "not_started"],
    ["Sign in to join", "auth_required"]
  ];
  for (const [text, expected] of unverified) {
    it(`classifies ${JSON.stringify(text)} as ${expected} (unverified: no capture exists for this state)`, () => {
      expect(classifyPreJoin(text)).toBe(expected);
    });
  }

  it("returns undefined for text it does not recognise", () => {
    // An unrecognised screen must NOT be forced into one of the five. The
    // caller retries or times out; guessing here would manufacture a
    // confident wrong outcome.
    expect(classifyPreJoin("something entirely new")).toBeUndefined();
  });

  it("does not match the plan's guessed waiting-room phrasing, which appears in no real capture", () => {
    // Neither phrase from the plan's original guess
    // (/asking to be let in|waiting for the host/i) appears anywhere in
    // prejoin-waiting.html. Pinned here so a future edit cannot silently
    // reintroduce it.
    expect(classifyPreJoin("Asking to be let in")).toBeUndefined();
    expect(classifyPreJoin("waiting for the host")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// joinMeeting: a controllable fake JoinPage, not a real browser and not
// fixture DOM (join-driver.ts is adapter-agnostic — it is Meet's real markup,
// exercised through googleMeetAdapter.join, that belongs in
// google-meet.test.ts).
// ---------------------------------------------------------------------------

const SELECTORS: PreJoinSelectors = {
  cameraToggle: "camera-toggle",
  micToggle: "mic-toggle",
  nameField: "name-field",
  joinButton: "join-button"
};

interface ElementState {
  count: number;
  ariaLabel?: string | null;
}

interface FakePageConfig {
  elements: Partial<Record<string, () => ElementState>>;
  text(): string;
}

function createFakePage(config: FakePageConfig): { page: JoinPage; calls: string[] } {
  const calls: string[] = [];
  const stateFor = (selector: string): ElementState =>
    config.elements[selector]?.() ?? { count: 0 };

  const page: JoinPage = {
    async goto(url) {
      calls.push(`goto:${url}`);
    },
    async innerText() {
      return config.text();
    },
    locator(selector: string): JoinLocator {
      const loc: JoinLocator = {
        async count() {
          return stateFor(selector).count;
        },
        async click() {
          calls.push(`click:${selector}`);
        },
        async fill(value: string) {
          calls.push(`fill:${selector}:${value}`);
        },
        first() {
          return loc;
        },
        async getAttribute(name: string) {
          if (name !== "aria-label") return null;
          return stateFor(selector).ariaLabel ?? null;
        }
      };
      return loc;
    },
    async waitForTimeout(ms: number) {
      calls.push(`wait:${ms}`);
    }
  };
  return { page, calls };
}

describe("driveToggle", () => {
  // The two answers that are NOT about the label convention itself — that
  // half is verified against the real captured camera labels in
  // google-meet.test.ts, on the one control whose both states were captured.
  const TOGGLE = "some-toggle";
  const withLabel = (label: string | null, count = 1) =>
    createFakePage({
      elements: { [TOGGLE]: () => ({ count, ariaLabel: label }) },
      text: () => ""
    });

  it("reports absent, and clicks nothing, when the control is not on the page", async () => {
    const { page, calls } = withLabel(null, 0);
    expect(await driveToggle(page, TOGGLE, "on")).toBe("absent");
    expect(calls).toEqual([]);
  });

  it("reports unrecognised, and clicks nothing, on a label that states no action", async () => {
    // The one case where clicking is worst: the click itself changes a state
    // we just established we cannot read. For captions that means a control
    // called to turn them ON could turn them OFF and destroy the meeting's
    // attribution.
    for (const label of ["Captions unavailable", "", "Subtitles"]) {
      const { page, calls } = withLabel(label);
      expect(await driveToggle(page, TOGGLE, "on")).toBe("unrecognised");
      expect(calls).toEqual([]);
    }
  });

  it("reports unrecognised on a label that somehow states BOTH actions", async () => {
    // Neither reading is safe, so neither is taken.
    const { page, calls } = withLabel("Turn on or turn off captions");
    expect(await driveToggle(page, TOGGLE, "on")).toBe("unrecognised");
    expect(calls).toEqual([]);
  });
});

/** A `now()` that advances by `stepMs` on every call, starting at 0 — enough
 * to drive a deterministic waiting-room deadline without a real wait. */
function steppedClock(stepMs: number): () => number {
  let value = -stepMs;
  return () => {
    value += stepMs;
    return value;
  };
}

const NEVER_ADMITTED = async () => false;
const NOT_ENDED = { hasEnded: async () => false };

/** An `isAdmitted` that reads true only once the join control has actually
 * been clicked.
 *
 * Used instead of a flat `async () => true` because a flat one models a page
 * Meet never serves: the real captures put every in-call admission anchor at
 * ZERO matches on both pre-join screens (see `IN_CALL_ANCHORS` in
 * `google-meet.ts`), so a page still offering "Ask to join" cannot also be
 * showing the in-call UI. Since `joinMeeting` now declines to classify
 * pre-join copy on a page that looks in-call, a fake claiming both at once
 * describes a contradiction rather than a meeting. */
function admittedAfterClick(calls: string[]): () => Promise<boolean> {
  return async () => calls.includes(`click:${SELECTORS.joinButton}`);
}

describe("joinMeeting", () => {
  it("fills the name field when the platform offers one", async () => {
    const { page, calls } = createFakePage({
      elements: {
        [SELECTORS.nameField]: () => ({ count: 1 }),
        [SELECTORS.joinButton]: () => ({ count: 1 })
      },
      text: () => "Ask to join"
    });
    await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: admittedAfterClick(calls)
    });
    expect(calls).toContain(`fill:${SELECTORS.nameField}:AI Notetaker`);
  });

  it("does not attempt to fill a name field that is not present, and does not throw", async () => {
    // Neither real pre-join capture carries an <input> at all — both were
    // signed in. Missing must be "nothing to fill", not an error.
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Ask to join"
    });
    await expect(
      joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
        selectors: SELECTORS,
        isAdmitted: admittedAfterClick(calls)
      })
    ).resolves.toBe("admitted");
    expect(calls.some((c) => c.startsWith(`fill:${SELECTORS.nameField}`))).toBe(false);
  });

  it("clicks the camera and microphone toggles when they read as currently on", async () => {
    // Verified against prejoin-ready.html: aria-label "Turn off camera" /
    // "Turn off microphone" with data-is-muted="false" — currently on.
    const { page, calls } = createFakePage({
      elements: {
        [SELECTORS.cameraToggle]: () => ({ count: 1, ariaLabel: "Turn off camera" }),
        [SELECTORS.micToggle]: () => ({ count: 1, ariaLabel: "Turn off microphone" }),
        [SELECTORS.joinButton]: () => ({ count: 1 })
      },
      text: () => "Ask to join"
    });
    await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: admittedAfterClick(calls)
    });
    expect(calls).toContain(`click:${SELECTORS.cameraToggle}`);
    expect(calls).toContain(`click:${SELECTORS.micToggle}`);
  });

  it("leaves the camera and microphone alone when they already read as off", async () => {
    // Verified against prejoin-waiting.html: aria-label "Turn on camera" /
    // "Turn on microphone" — already off, captured after the operator
    // muted both before asking to join.
    const { page, calls } = createFakePage({
      elements: {
        [SELECTORS.cameraToggle]: () => ({ count: 1, ariaLabel: "Turn on camera" }),
        [SELECTORS.micToggle]: () => ({ count: 1, ariaLabel: "Turn on microphone" }),
        [SELECTORS.joinButton]: () => ({ count: 1 })
      },
      text: () => "Ask to join"
    });
    await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: admittedAfterClick(calls)
    });
    expect(calls).not.toContain(`click:${SELECTORS.cameraToggle}`);
    expect(calls).not.toContain(`click:${SELECTORS.micToggle}`);
  });

  it("treats a missing camera control as nothing to turn off, not an error", async () => {
    // The capture host itself has no camera; Meet still rendered the
    // toggle. A machine where Meet renders no control at all must not throw.
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Ask to join"
    });
    await expect(
      joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
        selectors: SELECTORS,
        isAdmitted: admittedAfterClick(calls)
      })
    ).resolves.toBe("admitted");
  });

  /** The exact label is real captured Google Meet markup: in
   * `in-call-captions-off.html` the camera selector matches exactly one
   * element and it reads "Camera problem. Show more info" — Meet had
   * SUBSTITUTED a device-fault control for the toggle. `google-meet.test.ts`
   * measures that against the capture; this is the same label carried onto
   * the microphone, where the consequence is different.
   *
   * `unrecognised` does not mean "the device is on". It means this code
   * cannot tell — and on the microphone those are the same thing, because the
   * module's own standard is that a notetaker appearing with a live
   * microphone even for one second is a different product. Swallowed, the
   * device stays untouched, the join returns `admitted`, and nothing anywhere
   * reports it. */
  it("REFUSES to join when the microphone control is present but its label cannot be read", async () => {
    const { page, calls } = createFakePage({
      elements: {
        [SELECTORS.cameraToggle]: () => ({ count: 1, ariaLabel: "Turn off camera" }),
        [SELECTORS.micToggle]: () => ({
          count: 1,
          ariaLabel: "Microphone problem. Show more info"
        }),
        [SELECTORS.joinButton]: () => ({ count: 1 })
      },
      text: () => "Ask to join"
    });
    await expect(
      joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
        selectors: SELECTORS,
        isAdmitted: admittedAfterClick(calls)
      })
    ).rejects.toThrow(DeviceStateUnknownError);

    // Before the knock, so the refusal costs an attempt rather than a meeting
    // somebody is sitting in — and the microphone itself was never clicked,
    // because a blind click is the one action that could turn a live
    // microphone ON.
    expect(calls).not.toContain(`click:${SELECTORS.joinButton}`);
    expect(calls).not.toContain(`click:${SELECTORS.micToggle}`);
  });

  it("joins anyway when the CAMERA control is the unreadable one, because the real capture of that state is a broken camera", async () => {
    // The asymmetry is on evidence, not symmetry. The one real capture that
    // produces `unrecognised` is a camera-fault control, and a faulted camera
    // is not transmitting; refusing there would abandon meetings on any host
    // with a broken webcam.
    const { page, calls } = createFakePage({
      elements: {
        [SELECTORS.cameraToggle]: () => ({
          count: 1,
          ariaLabel: "Camera problem. Show more info"
        }),
        [SELECTORS.micToggle]: () => ({ count: 1, ariaLabel: "Turn off microphone" }),
        [SELECTORS.joinButton]: () => ({ count: 1 })
      },
      text: () => "Ask to join"
    });
    await expect(
      joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
        selectors: SELECTORS,
        isAdmitted: admittedAfterClick(calls)
      })
    ).resolves.toBe("admitted");
    expect(calls).not.toContain(`click:${SELECTORS.cameraToggle}`);
    expect(calls).toContain(`click:${SELECTORS.micToggle}`);
  });

  it("still treats an ABSENT microphone control as nothing to turn off", async () => {
    // The half that must not change: `absent` and `unrecognised` are
    // different answers, and only one of them is a refusal.
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Ask to join"
    });
    await expect(
      joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
        selectors: SELECTORS,
        isAdmitted: admittedAfterClick(calls)
      })
    ).resolves.toBe("admitted");
  });

  it("turns the camera and microphone off BEFORE clicking the join control, never after", async () => {
    const { page, calls } = createFakePage({
      elements: {
        [SELECTORS.cameraToggle]: () => ({ count: 1, ariaLabel: "Turn off camera" }),
        [SELECTORS.micToggle]: () => ({ count: 1, ariaLabel: "Turn off microphone" }),
        [SELECTORS.joinButton]: () => ({ count: 1 })
      },
      text: () => "Ask to join"
    });
    await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: admittedAfterClick(calls)
    });
    const cameraAt = calls.indexOf(`click:${SELECTORS.cameraToggle}`);
    const micAt = calls.indexOf(`click:${SELECTORS.micToggle}`);
    const joinAt = calls.indexOf(`click:${SELECTORS.joinButton}`);
    expect(cameraAt).toBeGreaterThanOrEqual(0);
    expect(micAt).toBeGreaterThanOrEqual(0);
    expect(joinAt).toBeGreaterThan(cameraAt);
    expect(joinAt).toBeGreaterThan(micAt);
  });

  it("returns denied/not_started/auth_required immediately, without ever clicking the join control (unverified: no capture exists for these three states)", async () => {
    // The CONTROL FLOW here is real and worth pinning: a terminal screen must
    // short-circuit before the join control is ever clicked. What is NOT real
    // is the three phrases it is driven with — a denied join, a meeting that
    // has not started and a sign-in wall could none of them be produced on
    // demand during the capture session (fixture README, "States not
    // captured"), so no Google markup has ever been seen carrying any of
    // them. They exercise this package's own PRE_JOIN_MARKERS constants and
    // nothing beyond that.
    //
    // Named `unverified` for the same reason every other test touching these
    // three states is: a green suite must not read as evidence about markup
    // nobody has looked at. If Google's real copy differs, this test stays
    // green and the classifier still matches nothing in production — which is
    // exactly the failure the fixture README was written about.
    for (const [text, expected] of [
      ["You can't join this call", "denied"],
      ["The meeting hasn't started", "not_started"],
      ["Sign in to join", "auth_required"]
    ] as const) {
      const { page, calls } = createFakePage({
        elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
        text: () => text
      });
      const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
        selectors: SELECTORS,
        isAdmitted: NEVER_ADMITTED
      });
      expect(outcome).toBe(expected);
      expect(calls.some((c) => c.startsWith(`click:${SELECTORS.joinButton}`))).toBe(false);
    }
  });

  it("clicks the join control once when the ready screen is recognised, and confirms admission from the in-call UI, not the click", async () => {
    let admittedChecks = 0;
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Ask to join"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      // Admission is confirmed only on the SECOND check — the first must
      // find us still not admitted even though the click already happened.
      isAdmitted: async () => {
        admittedChecks++;
        return admittedChecks > 1;
      }
    });
    expect(outcome).toBe("admitted");
    expect(calls.filter((c) => c === `click:${SELECTORS.joinButton}`)).toHaveLength(1);
  });

  it("does not report admitted while hasEnded still reads true, even if the in-call marker is present", async () => {
    // Guards a stale render of the in-call marker surviving into a
    // teardown: isAdmitted alone is not trusted if hasEnded disagrees. The
    // join control IS clicked here and the in-call marker DOES appear —
    // otherwise this would time out for the ordinary reason (never having
    // asked to join) and prove nothing about the hasEnded veto.
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Ask to join"
    });
    const outcome = await joinMeeting(
      { hasEnded: async () => true },
      page,
      "https://meet.example/x",
      "AI Notetaker",
      {
        selectors: SELECTORS,
        isAdmitted: admittedAfterClick(calls),
        waitingRoomTimeoutMs: 3000,
        pollMs: 1000,
        now: steppedClock(1000)
      }
    );
    expect(outcome).toBe("waiting_room_timeout");
    expect(calls).toContain(`click:${SELECTORS.joinButton}`);
  });

  it("never lets in-call text produce a pre-join verdict, once the in-call UI is up (unverified phrasing: the denial copy driving it appears in no capture)", async () => {
    // The defect: classifyPreJoin ran on the WHOLE page text every poll,
    // including after admission. A caption, a chat line or a participant's
    // display name reading "you can't join" would flip an already-successful
    // join to "denied" and abandon a meeting we were sitting in.
    //
    // Modelled at its sharpest, and with ONE page state behind both signals:
    // after two polls the page becomes the in-call UI, and its text becomes
    // a denial phrase in the same instant. A fake whose text lagged its
    // admission by a poll would let the old code pass for the wrong reason.
    let calls: string[] = [];
    const pollsElapsed = () => calls.filter((c) => c.startsWith("wait:")).length;
    const inCall = () => pollsElapsed() >= 2;
    const fake = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => (inCall() ? "You can't join this call" : "Ask to join")
    });
    calls = fake.calls;
    const outcome = await joinMeeting(
      NOT_ENDED,
      fake.page,
      "https://meet.example/x",
      "AI Notetaker",
      {
        selectors: SELECTORS,
        isAdmitted: async () => inCall(),
        waitingRoomTimeoutMs: 30_000,
        pollMs: 1000,
        now: steppedClock(1000)
      }
    );
    expect(outcome).toBe("admitted");
    expect(pollsElapsed()).toBeGreaterThanOrEqual(2);
  });

  it("does not classify a page an in-call MARKER is present on, even when isAdmitted says no", async () => {
    // Important 1. `admitted` used to answer two questions at once: are we
    // done, and is this page's text even a pre-join screen. Once isAdmitted
    // was narrowed to RENDERED anchors, an in-call page whose anchors were
    // mounted but not drawn would read as "not admitted" AND "safe to
    // classify" — the worse of the two errors, since classifying in-call
    // text abandons a meeting we are sitting in.
    //
    // Here the two signals disagree deliberately: isAdmitted is false,
    // inCallMarkerPresent is true, and the page text is a denial. The
    // honest answer is the timeout — we cannot confirm an admission we
    // cannot see, and we must not manufacture a denial from a page that is
    // demonstrably in-call.
    const { page } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "You can't join this call"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: NEVER_ADMITTED,
      inCallMarkerPresent: async () => true,
      waitingRoomTimeoutMs: 3000,
      pollMs: 1000,
      now: steppedClock(1000)
    });
    expect(outcome).toBe("waiting_room_timeout");
  });

  it("still classifies when the in-call marker is absent, so the second signal cannot silence a real verdict", async () => {
    // The other half: a genuine pre-join screen carries no marker at all, so
    // separating the two questions must not have closed the gate on it.
    const { page } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "You can't join this call"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: NEVER_ADMITTED,
      inCallMarkerPresent: async () => false
    });
    expect(outcome).toBe("denied");
  });

  it("falls back to isAdmitted's own answer, and asks it once a poll, when no second signal is supplied", async () => {
    // The documented default, pinned: an adapter that supplies only
    // isAdmitted gets the old single-signal behaviour and NO extra page
    // round trip. Asked once per poll, not twice — a second call would
    // double-count against any caller whose check is stateful.
    let checks = 0;
    const { page } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "You can't join this call"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: async () => {
        checks++;
        return false;
      }
    });
    expect(outcome).toBe("denied");
    expect(checks).toBe(1);
  });

  it("does not consult the second signal at all once isAdmitted says yes", async () => {
    // A rendered anchor is a present one, so the weaker query would be
    // asking a question whose answer is already known.
    let presenceChecks = 0;
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Ask to join"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: admittedAfterClick(calls),
      // Tracks the same page state as isAdmitted, because the real captures
      // put every in-call anchor at zero on both pre-join screens: a page
      // still offering "Ask to join" carries neither a rendered anchor nor a
      // hidden one. A flat `true` would describe a contradiction.
      inCallMarkerPresent: async () => {
        presenceChecks++;
        return calls.includes(`click:${SELECTORS.joinButton}`);
      }
    });
    expect(outcome).toBe("admitted");
    // Consulted only on the polls where isAdmitted said no — here, the
    // single pre-join poll before the click landed.
    expect(presenceChecks).toBe(1);
  });

  it("does not classify an in-call page we never clicked into, even when its text reads as a denial (unverified phrasing)", async () => {
    // The residual window the early return alone does not close: the in-call
    // UI is up but this loop never clicked anything (a direct-entry join, or
    // a page restored into a call), so the "admitted" return is withheld and
    // the loop keeps going. Without the gate it would classify that in-call
    // page and answer "denied" about a meeting it is sitting in.
    //
    // The honest answer is a timeout: we cannot confirm admission we did not
    // ask for, and a timeout is a slow, visible failure rather than a
    // confident wrong one.
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "You can't join this call"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: async () => true,
      waitingRoomTimeoutMs: 3000,
      pollMs: 1000,
      now: steppedClock(1000)
    });
    expect(outcome).toBe("waiting_room_timeout");
    expect(calls).not.toContain(`click:${SELECTORS.joinButton}`);
  });

  it("does not classify a torn-down in-call page, where the marker is up but hasEnded disagrees (unverified phrasing)", async () => {
    // The other residual window: admitted and clicked, but hasEnded vetoes
    // the return (a stale in-call render surviving into teardown). The loop
    // continues, and the page it is looking at is an in-call page — whose
    // text must still not be read as a pre-join verdict.
    let calls: string[] = [];
    const fake = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () =>
        calls.includes(`click:${SELECTORS.joinButton}`) ? "You can't join this call" : "Ask to join"
    });
    calls = fake.calls;
    const outcome = await joinMeeting(
      { hasEnded: async () => true },
      fake.page,
      "https://meet.example/x",
      "AI Notetaker",
      {
        selectors: SELECTORS,
        isAdmitted: admittedAfterClick(calls),
        waitingRoomTimeoutMs: 3000,
        pollMs: 1000,
        now: steppedClock(1000)
      }
    );
    expect(outcome).toBe("waiting_room_timeout");
    expect(calls).toContain(`click:${SELECTORS.joinButton}`);
  });

  it("stops reading the page text at all once admitted, rather than reading it and ignoring it", async () => {
    // Not merely "the verdict is discarded": the text is never fetched. That
    // is the difference between a window narrowed and a window closed — a
    // full-page innerText per poll is also the most expensive call in this
    // loop, and every read of it is a chance for content nobody controls to
    // reach a classifier.
    let textReads = 0;
    let calls: string[] = [];
    const fake = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => {
        textReads++;
        return "Ask to join";
      }
    });
    calls = fake.calls;
    let admittedChecks = 0;
    await joinMeeting(NOT_ENDED, fake.page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      // Admitted from the third check onwards: two pre-join polls, then in.
      isAdmitted: async () => {
        admittedChecks++;
        return admittedChecks >= 3;
      }
    });
    // Two polls saw a pre-join screen and read its text; the third saw the
    // in-call UI and returned without reading anything.
    expect(admittedChecks).toBe(3);
    expect(textReads).toBe(2);
    expect(calls).toContain(`click:${SELECTORS.joinButton}`);
  });

  it("keeps waiting on text it does not recognise, and times out rather than guessing", async () => {
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "a Meet screen this classifier has never seen"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: NEVER_ADMITTED,
      waitingRoomTimeoutMs: 3000,
      pollMs: 1000,
      now: steppedClock(1000)
    });
    expect(outcome).toBe("waiting_room_timeout");
    expect(calls.some((c) => c.startsWith(`click:${SELECTORS.joinButton}`))).toBe(false);
  });

  it("returns waiting_room_timeout once the deadline passes while still in the lobby", async () => {
    const { page } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Please wait until a meeting host brings you into the call"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: NEVER_ADMITTED,
      waitingRoomTimeoutMs: 3000,
      pollMs: 1000,
      now: steppedClock(1000)
    });
    expect(outcome).toBe("waiting_room_timeout");
  });

  /** The classifier's locale limit, as a BEHAVIOUR rather than a comment.
   *
   * `PRE_JOIN_MARKERS` matches English copy, and `/ask to join/i` is the only
   * thing in the loop that sets `clicked`. On a ready screen in another
   * language nothing matches, so the join control is never pressed and the
   * run times out having NEVER KNOCKED — a different failure from an anchor
   * miss, which times out with the bot very possibly sitting in the meeting,
   * and one that needs the opposite thing checked first.
   *
   * The text is the real captured ready screen's own phrase in French, which
   * is a translation and not a capture — so what this test pins is the
   * mechanism (unrecognised text never clicks), never a claim about what Meet
   * actually renders in that locale. */
  it("never clicks the join control on a ready screen whose copy it cannot read, so the room is never asked", async () => {
    const { page, calls } = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Demander à participer"
    });
    const outcome = await joinMeeting(NOT_ENDED, page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: NEVER_ADMITTED,
      waitingRoomTimeoutMs: 3000,
      pollMs: 1000,
      now: steppedClock(1000)
    });

    expect(outcome).toBe("waiting_room_timeout");
    // The whole point: the outcome above is indistinguishable from a lobby
    // timeout, and this is the fact that distinguishes them.
    expect(calls.some((c) => c.startsWith(`click:${SELECTORS.joinButton}`))).toBe(false);

    // The control was there to click, and the English copy does click it —
    // otherwise this would pass for any reason at all.
    const english = createFakePage({
      elements: { [SELECTORS.joinButton]: () => ({ count: 1 }) },
      text: () => "Ask to join"
    });
    await joinMeeting(NOT_ENDED, english.page, "https://meet.example/x", "AI Notetaker", {
      selectors: SELECTORS,
      isAdmitted: NEVER_ADMITTED,
      waitingRoomTimeoutMs: 3000,
      pollMs: 1000,
      now: steppedClock(1000)
    });
    expect(english.calls.some((c) => c.startsWith(`click:${SELECTORS.joinButton}`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// waitUntilMeetingEnded
// ---------------------------------------------------------------------------

describe("waitUntilMeetingEnded", () => {
  /** The narrowest tolerance this loop can express: one poll interval, which
   * is two readings. Stated explicitly by the three tests below, rather than
   * inherited from `HAS_ENDED_CONFIRM_MS`, because what they are about is the
   * CONSECUTIVE-streak rule and not the size of the shipped window — which is
   * a deployment question, has already changed once, and is pinned on its own
   * further down. */
  const TWO_READINGS = { confirmMs: DEFAULT_ENDED_POLL_MS };

  it("ends once hasEnded reads true on two CONSECUTIVE polls", async () => {
    let calls = 0;
    const adapter = {
      hasEnded: async () => {
        calls++;
        return true;
      }
    };
    await waitUntilMeetingEnded(adapter, {}, { wait: async () => {}, ...TWO_READINGS });
    expect(calls).toBe(2);
  });

  it("does NOT end after a single true reading — a network blip can reload Meet to a page with zero anchors, identical to prejoin-ready.html, for one poll", async () => {
    // Scripted: true, then false, then a guard that throws if polled beyond
    // that. If the loop wrongly ended on the lone `true` it would never
    // reach the guard, and the rejection below would never happen — this is
    // how "did not end early" is proven without waiting on a promise that,
    // on a bug, would simply never resolve.
    const script = [true, false];
    let calls = 0;
    const adapter = {
      hasEnded: async () => {
        if (calls >= script.length) {
          throw new Error(
            "polled past the scripted sequence — the lone `true` must not have ended it"
          );
        }
        return script[calls++];
      }
    };
    await expect(
      waitUntilMeetingEnded(adapter, {}, { wait: async () => {}, ...TWO_READINGS })
    ).rejects.toThrow(/polled past the scripted sequence/);
    expect(calls).toBe(script.length);
  });

  it("resets the streak on any false, and re-confirms rather than accumulating non-consecutive trues", async () => {
    // true, false, true, true: a cumulative "2 trues ever seen" counter
    // would end after the 3rd call. Consecutive counting requires the 4th.
    const script = [true, false, true, true];
    let calls = 0;
    const adapter = { hasEnded: async () => script[calls++] ?? true };
    await waitUntilMeetingEnded(adapter, {}, { wait: async () => {}, ...TWO_READINGS });
    expect(calls).toBe(4);
  });

  it("stops polling the moment its signal aborts, and does not poll again after", async () => {
    // The defect: session.ts races this against a duration ceiling and a
    // transcription-failure observer. When one of those wins, this loop is
    // abandoned mid-poll — and without cancellation it keeps calling
    // hasEnded on a page nobody owns any more, one call per interval, for
    // the life of the process.
    const controller = new AbortController();
    let calls = 0;
    const adapter = {
      hasEnded: async () => {
        calls++;
        if (calls === 3) controller.abort();
        return false;
      }
    };
    await expect(
      waitUntilMeetingEnded(adapter, {}, { wait: async () => {}, signal: controller.signal })
    ).rejects.toThrow();
    expect(calls).toBe(3);

    // And it stays stopped. A loop that merely rejected once while its
    // iteration kept scheduling would keep this number moving.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(3);
  });

  it("REJECTS on abort rather than resolving, because resolving reads as 'the meeting ended'", async () => {
    // session.ts maps this promise's resolution straight to
    // endedReason: "far_end". A cancelled poll that resolved would record a
    // meeting the room ended, on a run the duration ceiling ended.
    const controller = new AbortController();
    controller.abort();
    const settled: string[] = [];
    await waitUntilMeetingEnded(
      { hasEnded: async () => false },
      {},
      { wait: async () => {}, signal: controller.signal }
    ).then(
      () => settled.push("resolved"),
      () => settled.push("rejected")
    );
    expect(settled).toEqual(["rejected"]);
  });

  it("does not call hasEnded even once when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      waitUntilMeetingEnded(
        {
          hasEnded: async () => {
            calls++;
            return false;
          }
        },
        {},
        { wait: async () => {}, signal: controller.signal }
      )
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("interrupts a sleep already in flight, rather than serving out the interval", async () => {
    // A real poll sleeps for seconds. Cancellation that only took effect at
    // the top of the next iteration would hold a caller — and a pending
    // timer — for up to a full interval after teardown.
    const controller = new AbortController();
    let waitStarted = 0;
    const promise = waitUntilMeetingEnded(
      { hasEnded: async () => false },
      {},
      {
        pollMs: 60_000,
        signal: controller.signal,
        wait: (ms, signal) =>
          new Promise<void>((resolve, reject) => {
            waitStarted++;
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason as Error);
              },
              { once: true }
            );
          })
      }
    );
    // Let the first poll land and the sleep begin.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(waitStarted).toBe(1);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it("honours a custom tolerance, stated as a duration rather than a poll count", async () => {
    let calls = 0;
    const adapter = {
      hasEnded: async () => {
        calls++;
        return true;
      }
    };
    // Four seconds of tolerance at a two-second poll: three readings, because
    // three readings span two intervals. Stated in the unit the caller
    // reasons in — the same tolerance at a one-second poll must survive the
    // same four-second blackout, which a poll count cannot express.
    await waitUntilMeetingEnded(adapter, {}, { wait: async () => {}, confirmMs: 4000 });
    expect(calls).toBe(3);
  });

  /** The number this loop defends, in the unit it is stated in. A blackout of
   * just over two seconds used to end a meeting — the tap stopped, the
   * transcript truncated mid-meeting, a `far_end` written that never
   * happened — and the comment defending it cited the pre-join capture, which
   * scores 0 of 3 on the set this actually consults and therefore refutes it
   * (`googleMeetAdapter.hasEnded(prejoin-ready.html)` is `true`, in
   * `google-meet.test.ts`). */
  it("survives a blackout shorter than the tolerance, and ends once one outlasts it", async () => {
    const pollsFor = (ms: number): number => Math.ceil(ms / CAPTION_POLL_MS);
    const confirmPolls = confirmPollsForWindow(HAS_ENDED_CONFIRM_MS, CAPTION_POLL_MS);
    const blackoutPolls = pollsFor(25_000);

    // A 25-second blackout at the session's own one-second poll, the meeting
    // UI coming back, and then a real ending. If the blackout ended the
    // meeting, the loop stops at `blackoutPolls` and never reads the `false`
    // at all.
    const script = [
      ...Array.from({ length: blackoutPolls }, () => true),
      false,
      ...Array.from({ length: confirmPolls }, () => true)
    ];
    let index = 0;
    await waitUntilMeetingEnded(
      { hasEnded: async () => script[index++] ?? true },
      {},
      { wait: async () => {}, pollMs: CAPTION_POLL_MS }
    );

    // Every reading was consumed: the streak was reset by the `false` and had
    // to be rebuilt from zero. Under the old two-poll rule this stopped after
    // two.
    expect(index).toBe(script.length);
    expect(blackoutPolls).toBeGreaterThan(2);
  });

  it("spans the tolerance it is given, rather than falling one interval short", () => {
    // N readings are separated by N-1 intervals. Off by one here and the
    // window is a whole poll shorter than the number it advertises.
    expect((confirmPollsForWindow(30_000, 1000) - 1) * 1000).toBe(30_000);
    expect((confirmPollsForWindow(30_000, 2000) - 1) * 2000).toBe(30_000);
    // Never a single reading, whatever the arithmetic says: one reading
    // confirms nothing, which is the part of the old two-poll rule that was
    // right.
    expect(confirmPollsForWindow(0, 1000)).toBe(2);
    expect(confirmPollsForWindow(500, 1000)).toBe(2);
  });
});

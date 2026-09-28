# Parley

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/h6y3/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/h6y3/parley/actions/workflows/ci.yml)

**A one-shot voice-agent harness for real phone calls.**

Give Parley a bounded brief. It places one call, navigates the phone tree, talks to the person on
the other end, stays inside the authority you gave it, and returns evidence of what happened.

Parley is not a voice bridge with a prompt attached. It is the control surface around a voice
agent: the call contract, prompt boundary, telephony, tool permissions, runtime limits, outcome
record, and offline test harness needed to let an AI act on a phone call without giving it an open
line to improvise.

It is a standalone, MIT-licensed TypeScript monorepo. The default stack uses Twilio for telephony
and Gemini Live for the speaking agent. It is pre-1.0 and intended for developers building their
own lawful, consent-aware call workflows—not robocalling, spam, or a managed calling service.

## The short version

```text
your agent or app
    │
    │  one typed call envelope
    ▼
Parley
    ├── validates the destination, identity, authority, tools, limits, and required outcomes
    ├── creates one fresh realtime voice session for the call
    ├── gates every keypress, commitment, outcome, and hangup on the server
    └── emits a completed-call record with what happened and what is still missing
```

A call envelope can say, in effect:

- call this allowed number;
- introduce yourself this way;
- accomplish these independently tracked objectives;
- answer verification questions from this bounded fact set;
- press only these IVR digits;
- never spend more than this amount;
- wait this long on hold;
- record these outcome fields before ending; and
- make at most this many correlated attempts.

If a capability is not in the envelope, the model does not get the tool. If a required outcome is
missing, a partial record is rejected instead of being dressed up as success.

## Why a harness, not just a voice connection

Connecting audio is the easy part. The hard part is making a call complete the right job and fail
in a way another agent can safely understand.

Parley treats a call as a bounded operation:

- **One brief, one call.** Privileged instructions are rendered once as a fresh per-call
  `systemInstruction`. The spoken opening is a separate generic trigger, so the agent cannot
  accidentally read its assignment or structural markers aloud.
- **Tools are capabilities, not suggestions.** DTMF, outcome recording, and hangup exist only
  when the envelope declares the matching execution block.
- **The server is the authority boundary.** The model can propose a keypress, price, or outcome;
  the `ToolGate` decides whether it is allowed. Spend ceilings and complete outcome maps are
  enforced before anything is recorded.
- **Tool results cannot carry caller text back into the model.** Results are a closed union of
  constant strings, removing a common prompt-injection path.
- **Retries belong to one operation.** Stable operation IDs and attempt numbers let the daemon
  reject concurrent, duplicate, skipped, conflicting, or over-budget attempts before origination.
- **The record is evidence, not a summary vibe.** Completed records expose accepted and refused
  DTMF, answer classification, termination, expected outcome fields, and any missing objectives.
- **Safety fails closed.** Origination requires bearer-token authentication and an exact callable
  number allowlist. Twilio webhooks are signature-verified. Public hosts are allowlisted. Parley
  records no audio.

The phrase to remember is: **the model proposes; the server disposes.**

Read the exact guarantees in the [security model](docs/security-model.md) and the prompt boundary
in the [prompt guide](docs/prompt-guide.md).

## What it can do

Parley supports more than a polite conversation:

- navigate keypad IVRs with in-band DTMF;
- wait through phone queues and bounded lookup pauses;
- disclose identity honestly under principal, represented, or transactional call policies;
- make only the commitments the envelope permits;
- record independently required outcomes;
- end the call cleanly instead of getting trapped in surveys or goodbye loops;
- run post-call hooks without blocking the call path; and
- join a meeting, announce itself, obtain a declared consent phrase, then hand off to a silent
  transcript-only listening plane that cannot send audio back into the meeting.

Meeting transcription is still third-party capture and carries its own consent obligations. See
[Meeting notetaking](docs/security-model.md#meeting-notetaking--consent-not-absence-of-capture)
for the control and its limits.

## Quickstart

Requirements: Node.js 20+, pnpm 9.15.0, a Twilio voice number, a Gemini API key, and a public HTTPS
endpoint for Twilio callbacks.

```bash
git clone https://github.com/h6y3/parley.git
cd parley
corepack enable
pnpm install
pnpm build

cp .env.example .env
# Fill in the required values, then:
node packages/cli/dist/cli.js doctor
node packages/cli/dist/cli.js serve
```

In another terminal:

```bash
node packages/cli/dist/cli.js harness preview \
  --brief examples/briefs/represented.json

node packages/cli/dist/cli.js call \
  --to +15555550187 \
  --brief examples/briefs/represented.json
```

`parley call` fails closed unless the destination is present in `PARLEY_CALLABLE_NUMBERS`, and
`POST /call` requires `Authorization: Bearer $PARLEY_CALL_TOKEN`. The full walkthrough is in
[Getting Started](docs/getting-started.md).

> The `parley` binary is installed by `@parley/cli`, but a fresh clone does not link it globally.
> The `node packages/cli/dist/cli.js …` form above always works after `pnpm build`.

## The call envelope

Parley's public input is a versioned JSON envelope. Version 2 pairs conversational policy with
binding execution controls:

```json
{
  "version": 2,
  "brief": {
    "to": "+15555550123",
    "persona": "I am Ada, calling on behalf of Alex Rivera, Alex's personal assistant.",
    "objective": "Move Alex Rivera's appointment to Monday or Tuesday next week.",
    "facts": [
      "The appointment is with Dr. Nguyen.",
      "Alex can accept any available time on either day."
    ],
    "operation": {
      "id": "appointment-reschedule-2026-09",
      "attempt": 1,
      "maxAttempts": 3
    }
  },
  "policy": {
    "principalName": "Alex Rivera",
    "identity": { "style": "onBehalf", "role": "personal assistant" },
    "disclosure": { "honestIfAsked": true, "volunteer": false },
    "scope": { "lock": true },
    "grounding": { "antiInvention": false },
    "deferral": { "enabled": true },
    "authority": {},
    "callback": { "number": "+15555550123" },
    "wrapUp": { "enabled": true }
  },
  "execution": {
    "closure": { "requireOutcomeBeforeEnd": true },
    "outcome": {
      "fields": [
        { "name": "scheduledDate", "description": "Confirmed appointment date" },
        { "name": "scheduledTime", "description": "Confirmed appointment time or window" },
        { "name": "confirmationNumber", "description": "Confirmation number, or empty if none" }
      ]
    }
  }
}
```

See [Configuration](docs/configuration.md#the-call-envelope) for the complete schema and
validation rules.

## Test before you dial—and learn from the live call

Parley ships an offline harness because a transcript that looks plausible is not enough:

1. `harness preview` shows the exact privileged instruction and spoken opening before a call.
2. Reliability runs exercise multi-turn derails against the realtime model.
3. Generated scenarios derive their expectations from parameters rather than authoring a
   flattering script and its answer key together.
4. Metamorphic pairs test relationships between runs—for example, raising a quoted price above
   the ceiling must remove the recorded amount.

Then place a controlled live call anyway. Offline tests cannot invent every carrier, IVR, queue,
audio, or human behavior. Parley's development loop is deliberately:

```text
offline matrix → controlled live call → inspect the record → repair → rerun the matrix
```

That is not an admission that the harness failed. It is what the harness is for: make live
failure bounded, observable, reproducible, and promotable into the next reusable control.

See [Scenario Authoring](docs/scenario-authoring.md), especially
[What the harness cannot see](docs/scenario-authoring.md#what-the-harness-cannot-see).

## Packages

| Package                                                             | Role                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`@parley/core`](packages/core)                                     | Per-call orchestration, prompt rendering, provider interfaces, redaction, and `ToolGate` |
| [`@parley/policy`](packages/policy)                                 | Versioned call-envelope schema, policy composition, and call presets                     |
| [`@parley/audio`](packages/audio)                                   | Audio conversion, framing, barge-in buffering, and DTMF synthesis                        |
| [`@parley/telephony-twilio`](packages/telephony-twilio)             | Twilio origination, signed webhooks, Media Streams, drain, and hangup                    |
| [`@parley/realtime-gemini`](packages/realtime-gemini)               | Default Gemini Live speaking-plane provider                                              |
| [`@parley/realtime-deepgram`](packages/realtime-deepgram)           | Experimental Deepgram speaking-plane provider                                            |
| [`@parley/transcription-deepgram`](packages/transcription-deepgram) | Silent meeting transcription provider                                                    |
| [`@parley/server`](packages/server)                                 | Authenticated call API, answer webhook, media WebSocket, and operation reservations      |
| [`@parley/cli`](packages/cli)                                       | `serve`, `call`, `doctor`, and `harness` commands                                        |
| [`@parley/harness`](packages/harness)                               | Preview, reliability, scenario, and metamorphic testing                                  |
| [`@parley/meeting-browser`](packages/meeting-browser)               | Browser-driven meeting transport, consent disclosure, captions, and attribution          |

## Documentation

| Start here                                             | Purpose                                               |
| ------------------------------------------------------ | ----------------------------------------------------- |
| [Getting Started](docs/getting-started.md)             | Clone to first controlled call                        |
| [Agent Setup](docs/agent-setup.md)                     | Copy-paste prompts for an AI coding agent             |
| [Configuration](docs/configuration.md)                 | Environment and complete envelope schema              |
| [Architecture](docs/architecture.md)                   | How the harness fits together                         |
| [Security Model](docs/security-model.md)               | Trust boundaries and fail-closed guarantees           |
| [Prompt Guide](docs/prompt-guide.md)                   | Why privileged instructions stay separate from speech |
| [Deployment](docs/runbooks/deployment.md)              | Run the daemon under launchd or systemd               |
| [Provider Authoring](docs/provider-authoring-guide.md) | Add telephony or realtime providers                   |
| [Scenario Authoring](docs/scenario-authoring.md)       | Generate and evaluate call scenarios                  |
| [Examples](examples/scenarios/README.md)               | Ready-to-run scenarios and briefs                     |

## Lawful use

Parley places outbound, AI-driven calls. Laws governing consent, AI disclosure, automated calling,
recording, monitoring, and do-not-call obligations vary by jurisdiction. Compliance is the
operator's responsibility.

Parley records no call audio. Meeting mode can produce a text transcript through a third-party
transcription service after its declared consent gate. That is still capture and may require
all-party consent. A spoken consent phrase records that the words were said; it does not
authenticate the speaker.

Do not use Parley for unlawful, deceptive, harassing, fraudulent, or mass unsolicited calling.
The software is provided under the MIT License as-is, without warranty.

## Project status and contributing

Parley is pre-1.0. Its interfaces are usable but may change before 1.0. See
[CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), the
[Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

Issues, pull requests, and security reports are welcome. There is no guaranteed response time or
maintenance commitment.

## License

MIT — see [LICENSE](LICENSE).

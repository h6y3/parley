# Parley

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/h6y3/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/h6y3/parley/actions/workflows/ci.yml)

**Brief an AI, have it make a phone call — without it leaking its instructions.**

Not a managed platform, not a generic AI wrapper, and not for spam or robocalls — fail-closed by design (allowlist, signature-verified webhooks, no recording); the calls you place are your responsibility to make lawful.

Parley is a standalone, MIT-licensed TypeScript library and daemon for briefed outbound phone
calls with Gemini Live over Twilio. It exists because the failure modes of this class of system —
a model reciting its own instructions instead of following them, burying the actual per-call
assignment under generic policy text, voicing structural markers meant to stay silent, and
validation harnesses that look clean on a single text turn and then fail on a real, multi-turn
phone call — are non-obvious, well-documented in production telephony deployments, and structural
in cause. Parley's answer is to make the correct pattern — a fresh, per-call `systemInstruction`
sent once at connect, and a single short generic opening line, and nothing else that can carry
privileged content — the _only_ path the library's interfaces expose. See
[`docs/prompt-guide.md`](docs/prompt-guide.md) for the full guarantee and why it holds.

## Completing a call, not just holding one

A call that reaches a person still has to end somewhere: a phone tree navigated, a scope agreed,
a price accepted or refused, an outcome written down, a line hung up. Parley gives the model a
small, closed set of tools for that — press keys, record the outcome, end the call — and puts a
server-side gate in front of every one of them. **The model proposes; the server disposes.**

- **Capability is declared by presence, not by a boolean.** A call envelope that carries no
  `execution.ivr` block cannot press a key, because the tool is never declared to the model.
- **Tool results are a closed union of string constants.** Nothing a caller says can reach the
  model through a tool result, because no tool result is ever built by interpolating text.
- **The spend ceiling is enforced where it can be enforced.** `execution.spendCeiling` binds an
  outcome field to a hard limit and the gate refuses an over-limit record _before writing
  anything_ — a partial record with the appointment kept and the price dropped would read as
  free. The prose rail asks the model to behave; the gate is what makes it binding.
- **Keypresses are audio.** DTMF is synthesized by `@parley/audio` and sent in-band down the
  media stream the call is already on, which is how a telephone keypad has always worked.

See [`docs/configuration.md`](docs/configuration.md#execution--the-binding-plane) for the wire
format and [`docs/security-model.md`](docs/security-model.md#the-tool-channel--bounded-capability-constant-only-results)
for why the gate holds.

## Packages

| Package                                                 | Responsibility                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@parley/core`](packages/core)                         | `TelephonyProvider`/`RealtimeProvider` interfaces, the `CallSession` orchestrator, the pure-caller-content `Brief` type, generic `systemInstruction` rendering, redaction, and the `ToolGate` that decides what a model's tool call is actually allowed to do. Policy-agnostic — knows nothing about modes or disclosure. |
| [`@parley/policy`](packages/policy)                     | The `CallPolicy`/`CallEnvelope`/`CallExecution` schema (zod-validated), guardrail composition (`composePolicy`), and the `principalCall`/`representedCall`/`transactionalCall`/`navigableCall` presets.                                                                                                                   |
| [`@parley/audio`](packages/audio)                       | μ-law ⟷ PCM resampling, frame handling, barge-in buffer management, and DTMF tone synthesis. Usable standalone.                                                                                                                                                                                                           |
| [`@parley/telephony-twilio`](packages/telephony-twilio) | `TelephonyProvider` implementation for Twilio: origination, TwiML, fail-closed signature verification, Media Streams, carrier-confirmed outbound drain, hangup.                                                                                                                                                           |
| [`@parley/realtime-gemini`](packages/realtime-gemini)   | `RealtimeProvider` implementation for Gemini Live via the official `@google/genai` SDK.                                                                                                                                                                                                                                   |
| [`@parley/server`](packages/server)                     | The daemon: `POST /call`, the Twilio answer webhook, and the media-stream WebSocket endpoint — wires `@parley/core` and `@parley/policy` to the two provider packages over plain `node:http` + `ws`.                                                                                                                      |
| [`@parley/cli`](packages/cli)                           | The unified `parley` binary: `serve`, `call`, `harness …`, `doctor`.                                                                                                                                                                                                                                                      |
| [`@parley/harness`](packages/harness)                   | Offline prompt/reliability tester: text and audio turns, multi-turn derail scripts, generated multi-turn call scenarios with derived expectations, metamorphic pairs, failure-rate reporting, payload preview.                                                                                                            |

`examples/agent-integration`, `examples/express-minimal`, and `examples/briefs` (below) round out the
repo; they are reference material, not packages in the pnpm workspace.

## Quickstart

```bash
pnpm install
pnpm build

cp .env.example .env
# edit .env: GEMINI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
# PARLEY_PUBLIC_HOST, PARLEY_CALLABLE_NUMBERS, PARLEY_CALL_TOKEN (openssl rand -hex 32)

parley serve
# in another terminal:
parley call --to +15555550187 --brief examples/briefs/represented.json
```

> **Allowlist reminder:** `parley call` fails closed unless `--to` is in `PARLEY_CALLABLE_NUMBERS`
> — add `+15555550187` (or your real target) there first. See
> [`docs/getting-started.md`](docs/getting-started.md#6-place-your-first-call) for the full explanation.

> **Auth reminder:** `POST /call` requires `Authorization: Bearer $PARLEY_CALL_TOKEN`, and the
> daemon refuses to start without the variable. The callable-number allowlist bounds who may be
> _dialled_, never who may _dial_ — the token is the control on origination. See
> [`docs/security-model.md`](docs/security-model.md#post-call-authentication--the-primary-control).

> **Note:** `parley` above is the name of the binary `@parley/cli` installs (its `bin` entry). A
> fresh clone doesn't link it onto `PATH` — run the same commands as
> `node packages/cli/dist/cli.js serve` / `node packages/cli/dist/cli.js call ...` instead. See
> [`docs/getting-started.md`](docs/getting-started.md) for the full from-scratch walkthrough.

`parley serve` boots the daemon (`@parley/server`) and reads all configuration and secrets from
the environment — never from a CLI flag or a committed file. `parley call` is a thin HTTP client:
it reads a call envelope (`{ version, brief, policy }`) JSON file and `POST`s it to the running
daemon's `/call`; it does not embed an in-process server. Run `parley doctor` to check which
required secrets are present without ever printing their values, and `parley harness preview
--brief <path>` to read the exact `systemInstruction`/opening-trigger payload a brief would
produce before it goes anywhere near a live call.

## Documentation

| Doc                                                    | For                                                |
| ------------------------------------------------------ | -------------------------------------------------- |
| [Getting Started](docs/getting-started.md)             | First-time human setup → first call                |
| [Configuration](docs/configuration.md)                 | Every env var and call-envelope field              |
| [Agent Setup](docs/agent-setup.md)                     | Copy-paste prompts to drive setup from an AI agent |
| [Deployment](docs/runbooks/deployment.md)              | Running the daemon as a service (launchd/systemd)  |
| [Prompt Guide](docs/prompt-guide.md)                   | Why the systemInstruction design holds             |
| [Architecture](docs/architecture.md)                   | How the packages fit together                      |
| [Security Model](docs/security-model.md)               | Fail-closed guarantees                             |
| [Provider Authoring](docs/provider-authoring-guide.md) | Adding a telephony/realtime provider               |
| [Scenario Authoring](docs/scenario-authoring.md)       | Seeding, generating and measuring call scenarios   |
| [Examples](examples/scenarios/README.md)               | 12 ready-to-run call scenarios                     |

## Examples

- [`examples/agent-integration`](examples/agent-integration) — a generic agent-framework
  integration: a thin script that `POST`s a `Brief` to a running daemon's `/call` using only
  `fetch` — no `@parley/core` import — proving the public HTTP API is sufficient on its own.
- [`examples/express-minimal`](examples/express-minimal) — illustrative-only: embedding
  `@parley/core` and the provider packages directly inside a small Express app, without the
  standalone daemon. Not part of the pnpm workspace, not built, and `express` is not a dependency
  of this repo. Use `@parley/server` for the complete, secure-by-default path.
- [`examples/briefs`](examples/briefs) — sample call envelopes (`{ version, brief, policy }`,
  `@parley/policy`'s wire format) for all three identity styles: `principal.json`,
  `represented.json`, `transactional.json`.

## Before any real call

**No live call happens against a real phone number without first passing the offline harness.**
There are three layers, and each catches something the one below it cannot:

1. **`parley harness reliability`** drives the real `RealtimeProvider` against synthesized
   multi-turn derail scenarios and requires ~20 consecutive clean runs per critical scenario. See
   [`docs/prompt-guide.md`](docs/prompt-guide.md#auditing-the-exact-payload-before-a-call) for why
   an aggregate pass rate or a single-turn text check is not sufficient.
2. **`parley harness scenario`** runs generated multi-turn call scenarios — a matrix over cost
   shapes and complications — against a live tool channel, and reports **failure rates with typed
   codes** rather than a pass count. A run that scores 14/20 twice has not repeated itself; two
   different sets of five can fail. Expectations are _derived_ from each scenario's declared
   parameters, never authored alongside its prose, so a generator that writes a flattering script
   cannot also write itself a passing grade.
3. **Metamorphic pairs** check a property _between two runs_ — raise a quoted price above the
   ceiling and the recorded amount must disappear — which needs no correct absolute answer, and so
   survives the fact that no oracle exists for "did this call go well".

**And then you place a live call anyway.** On this codebase a green matrix and eight clean
metamorphic pairs were followed immediately by eleven real defects on the first live calls, none
of them reachable from 542 passing tests. Two structural reasons, both documented in
[`docs/scenario-authoring.md`](docs/scenario-authoring.md#what-the-harness-cannot-see):

- **A mock at the boundary tests the code above it and asserts nothing about the boundary.** The
  single method that mattered most had no test at all, in a package with 38 of them.
- **The harness supplies the world, so it cannot produce a state it does not imagine.** Silence at
  call start, a callee asking something no script asks, audio still in flight at hangup — no
  generated script contained any of them.

So the live gate is part of the loop, not a formality after it: offline matrix → merge → live call
against a number you control → fix → re-run the matrix. Note the last step. A _correct_ product
change can drop the matrix score, because the fixtures still model the old conversational shape —
that happened here, cost six points, and looked exactly like a regression in the class the change
had just touched.

## Lawful use

Parley places **outbound, AI-driven voice calls**. Whether, how, and to whom you may do that is
governed by law that varies by jurisdiction — and complying with it is entirely the operator's
responsibility, not the library's. Before you dial a real number, understand the rules that apply
to you, including at least:

- **Consent and recording.** Many jurisdictions are all-party-consent for recording or monitoring
  a call. (Parley itself does **not** record calls.)
- **AI / automated-caller disclosure.** A growing number of jurisdictions require that the person
  on the line be told they are speaking with an AI or automated system. Parley's `onBehalf` and
  `silent` identity styles are designed to support honest disclosure; use them accordingly.
- **Telemarketing, robocall, and do-not-call rules** (e.g. TCPA and equivalents), which can apply
  regardless of intent.

Parley ships fail-closed controls — a callable-number allowlist, Twilio signature verification, an
SSRF-safe webhook host allowlist, and no call recording — but these are engineering safeguards, not
legal compliance, and they do not make any given call lawful. **Do not use Parley for unlawful,
deceptive, harassing, fraudulent, or mass unsolicited calling.** The software is provided under the
MIT license **as-is, without warranty**; you assume all responsibility and risk for the calls you
place with it.

## Project status

Parley is pre-1.0. The interfaces described here are stable enough to build on,
but may change before 1.0. See [CHANGELOG.md](CHANGELOG.md).

This repository is **provided as-is**: issues, PRs, and security reports are welcome, but there
is no guaranteed response time or maintenance commitment. Don't rely on the maintainer being
available to field reports or merge contributions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).

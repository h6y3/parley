# Contributing to Parley

Thanks for your interest in improving Parley. This guide covers the toolchain, workflow, and a
few conventions specific to this repo.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm 9.15.0**, enabled via [Corepack](https://nodejs.org/api/corepack.html):

  ```bash
  corepack enable
  ```

  Corepack reads the `packageManager` field in `package.json` and will fetch the pinned pnpm
  version automatically — you don't need to install pnpm separately.

## Setup

```bash
pnpm install
pnpm build
```

`pnpm install` installs and links all workspace packages. `pnpm build` compiles every package in
dependency order; run it after `install` and after pulling changes that touch package internals,
since packages consume each other's built output rather than source.

## Workflow

Before opening a PR, all of the following must pass:

```bash
pnpm test         # unit + integration tests, all packages
pnpm typecheck     # TypeScript project references, all packages
pnpm lint          # eslint .
pnpm format        # prettier --write .
```

CI runs `lint`, `typecheck`, `test`, and `build` — it does not check formatting (`eslint.config.js`
uses `eslint-config-prettier`, which disables ESLint's formatting rules in favor of Prettier). Run
`pnpm format` yourself before committing; nothing in CI will catch unformatted code for you. If a
check fails, fix it locally and re-run rather than pushing and waiting on CI.

## Monorepo layout

Parley is a pnpm workspace with eight packages under `packages/`:

| Package | Responsibility |
|---|---|
| [`@parley/core`](packages/core) | `TelephonyProvider`/`RealtimeProvider` interfaces, the `CallSession` orchestrator, the pure-caller-content `Brief` type, generic `systemInstruction` rendering, redaction. Policy-agnostic. |
| [`@parley/policy`](packages/policy) | The `CallPolicy`/`CallEnvelope` schema (zod-validated), guardrail composition (`composePolicy`), and the `principalCall`/`representedCall`/`transactionalCall` presets. |
| [`@parley/audio`](packages/audio) | μ-law ⟷ PCM resampling, frame handling, barge-in buffer management. Usable standalone. |
| [`@parley/telephony-twilio`](packages/telephony-twilio) | `TelephonyProvider` implementation for Twilio: origination, TwiML, fail-closed signature verification, Media Streams, DTMF, hangup. |
| [`@parley/realtime-gemini`](packages/realtime-gemini) | `RealtimeProvider` implementation for Gemini Live via the official `@google/genai` SDK. |
| [`@parley/server`](packages/server) | The daemon: `POST /call`, the Twilio answer webhook, and the media-stream WebSocket endpoint. |
| [`@parley/cli`](packages/cli) | The unified `parley` binary: `serve`, `call`, `harness …`, `doctor`. |
| [`@parley/harness`](packages/harness) | Offline prompt/reliability tester: text and audio turns, multi-turn derail scripts, N-run reliability reporting, payload preview. |

`examples/` holds reference material (an agent-integration script, an illustrative Express
embedding, and sample call envelopes) — not packages in the pnpm workspace.

## Adding a provider

`TelephonyProvider` and `RealtimeProvider` are the two extension points in `@parley/core`. If
you're implementing a new telephony backend or realtime-voice backend, start with
[`docs/provider-authoring-guide.md`](docs/provider-authoring-guide.md) — it walks through both
interfaces using the shipped Twilio and Gemini providers as worked examples.

## Commit style

This repo uses [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
`docs:`, `refactor:`, `test:`, `chore:`, etc., optionally scoped to a package, e.g.
`fix(telephony-twilio): verify signature on retried webhooks`. Keep commits atomic — one logical
change per commit.

## Sample-identity rule

> Examples and tests must never contain a real person's name or real infrastructure. Use the
> project's sample identity: principal **Alex Rivera**, assistant **Ada**, callback
> **+15555550123**, host **voice.example.com**.

This applies to fixtures, docs, test data, and anything that ends up in git history — real names,
numbers, or hostnames don't belong in this repo, even as placeholders that "look real."

## No CLA

Parley does not require a Contributor License Agreement. By submitting a pull request, you agree
your contribution is licensed under the repo's [MIT license](LICENSE).

## Code of conduct

Participation in this project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

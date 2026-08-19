# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-08-19

Completing the call: a model can now navigate a phone tree, agree to a charge under an enforced
ceiling, record a structured outcome, and hang up cleanly — with a server-side gate in front of
every one of those. Plus the harness that measures whether it did, and the authentication that
`POST /call` was missing.

Pre-1.0, so the breaking changes below bump the minor version. Three of them require action on
upgrade; see **Upgrading** at the end of this entry.

### Added

- **Execution plane** (`@parley/core`'s `execution.ts`, `@parley/policy`'s `callExecutionSchema`).
  An envelope's advisory `brief`/`policy` now sits beside a binding `execution` block. Capability
  is declared by **presence**, not by an `enabled` flag: an envelope with no `execution.ivr` block
  cannot press a key, because the tool is never declared to the model.
- **Tool channel**: `press_digits`, `record_outcome`, `end_call`, routed through `ToolGate`.
  `ToolResult` is a closed union of string literals (`TOOL_RESULTS`) and is never built by
  interpolation, so nothing a caller says can reach the model through a tool result.
- **Enforced spend ceiling**: `execution.spendCeiling` binds an outcome field to a hard limit.
  `ToolGate.recordOutcome` refuses an over-limit record **before writing anything** — a partial
  record with the appointment kept and the price dropped would read as free. The schema requires
  the ceiling to be declared coherently across both planes, with matching limits.
- **DTMF synthesis** (`@parley/audio`): `dtmfMuLaw`, `DTMF_FREQUENCIES`. Keypresses are audio,
  sent in-band down the media stream the call is already on.
- **Carrier-confirmed drain** (`@parley/telephony-twilio`): `MediaStreamHandle.drainOutbound`
  waits out the local queue, sends a Twilio `mark`, and resolves on the carrier's echo — so a
  hangup no longer truncates the goodbye. `CallSession` also waits for the model's turn to finish
  before draining.
- **`navigableCall` preset** and new policy rails for adjacency, IVR, preferences, spend and
  patience.
- **Call scenario harness** (`@parley/harness`): multi-turn `CallScenario` with expectations
  _derived_ from each scenario's declared parameters rather than authored beside its prose; a
  generator over a cost/complication matrix; a structural evaluator; failure **rates** with typed
  codes instead of pass counts; `--concurrency`; and a `parley-harness` bin entry that works.
- **Metamorphic pairs** (`@parley/harness`'s `metamorphic.ts`): a deterministic source transform
  raises a quoted price above the ceiling, and the relation between the two runs is checked — a
  property that needs no correct absolute answer. Unpairable scenarios and vacuous passes are
  reported as such rather than counted as holding.
- **Twilio status callbacks and answering-machine detection**; `POST /twilio/status`.
- **Structured call record** returned by the daemon, with the outcome the model recorded.
- **`PARLEY_BIND_HOST`** (default `127.0.0.1`) and **`PARLEY_AUTHOR_MIN_INTERVAL_MS`**.
- **[`docs/scenario-authoring.md`](docs/scenario-authoring.md)** — seeding, generating, running and
  reading scenarios, including what the harness structurally cannot see and why a correct product
  change can look like a regression.
- A test that walks every fenced JSON envelope in the docs and parses it, so a documented example
  cannot drift out of the schema.

### Changed

- **Wire version 2.** `version: 2` accepts the `execution` block. `version: 1` envelopes remain
  valid and are treated as carrying no execution plane; a v1 envelope that declares `execution`
  is rejected rather than silently downgraded.
- The daemon binds **loopback by default**. It previously bound every interface, and no
  configuration existed that could have stopped it — `server.listen(port, resolve)` puts the
  callback where Node's host argument goes.
- `renderSystemInstruction`'s opening trigger now tells the model the call has just connected and
  that waiting means _silence_ — not announcing that it is waiting.
- Transcript entries store one entry per model turn rather than one per streamed fragment.
- The wrap-up rail asks what the other side still needs before closing, rather than only
  summarizing what was agreed. An appointment nobody can act on is not an appointment.

### Removed

- **`TelephonyProvider.sendDtmf`** — removed from the interface and from the Twilio provider.
  It posted replacement TwiML, which _redirects_ a live call and tore down `<Connect><Stream>`;
  every keypress hung up. Keypresses are now `AudioCodec.dtmfTones`, in-band.
- `OPENING_TRIGGER` is no longer exported from `@parley/policy`. It was a second copy of the
  constant in `@parley/core` that nothing imported and that drifted the moment the real one
  changed. Import it from `@parley/core`.

### Fixed

- A model hangup no longer cuts off its own final sentence.
- The spend ceiling is a running total for the whole call, not a per-item price.
- The ceiling is private: the model no longer announces having a budget or a maximum.
- The model no longer invents specifics — an address, a name, a date, an account number — that
  the brief did not give it.
- The model no longer presses keys into silence as an opening move, and is told what to do when
  no menu option matches.
- The outcome is recorded before the goodbye rather than after it, so a callee who hangs up first
  no longer leaves the call unrecorded.

### Security

- **`POST /call` now requires authentication** — `Authorization: Bearer $PARLEY_CALL_TOKEN`,
  compared in constant time, checked _before_ the body is parsed so an anonymous caller cannot
  distinguish a malformed envelope from an unlisted number and enumerate the allowlist. It fails
  closed on an unconfigured token (`503` to everybody, never open to everybody), and `parley serve`
  refuses to start without the variable.
  This route was previously unauthenticated. The callable-number allowlist is **not** access
  control — it bounds who may be _dialled_, never who may _dial_ — and counting it as
  authentication is what left the route open.
- `POST /twilio/answer` and `/twilio/status` remain deliberately un-gated by the token: Twilio
  cannot present one. Their control is signature verification.
- `parley doctor` now reports `PARLEY_CALL_TOKEN` presence, still without printing any value.

### Upgrading

1. **Set `PARLEY_CALL_TOKEN`** (`openssl rand -hex 32`) in the daemon's environment _and_ wherever
   `parley call` or your own client runs. Without it `serve` will not start.
2. **Check your ingress still reaches the daemon.** It now binds `127.0.0.1`; set
   `PARLEY_BIND_HOST` only if you have a specific reason not to front it with a tunnel or proxy.
3. **Custom `TelephonyProvider` implementations**: delete `sendDtmf`. If you relied on it, supply
   `dtmfTones` on your `AudioCodec` instead (`@parley/audio`'s `createAudioCodec` already does).

## [0.1.0] — 2026-07-28

### Added

- Initial public release: briefed outbound phone calls with Gemini Live over Twilio.
- Packages: `@parley/core`, `@parley/policy`, `@parley/audio`,
  `@parley/telephony-twilio`, `@parley/realtime-gemini`, `@parley/server`,
  `@parley/cli`, `@parley/harness`.
- `parley` CLI: `serve`, `call`, `harness`, `doctor`.
- Offline harness: text/audio turns, multi-turn derail scripts, N-run
  reliability reporting, payload preview.
- Example library and getting-started, configuration, agent-setup, and
  deployment documentation.

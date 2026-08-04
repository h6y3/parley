# Getting started

A from-scratch walkthrough: clone the repo, configure it, and place your first briefed phone
call. The install, config-check, `serve`, and `call` commands below were run against this repo to
write this page. All phone numbers, hostnames, and names are samples — substitute your own.

For the full environment-variable reference and the call-envelope schema, see
[`docs/configuration.md`](configuration.md). For running the daemon as a supervised, always-on
service, see [`docs/runbooks/deployment.md`](runbooks/deployment.md). If you'd rather have an AI
coding agent do the setup and validation for you, see [`docs/agent-setup.md`](agent-setup.md) —
it has copy-paste prompts for the same steps below plus the offline reliability harness.

## 1. What you need

- **Node.js ≥20** and `corepack enable` (this repo pins `pnpm@9.15.0` via `packageManager` in
  `package.json` — corepack installs and shims that version automatically).
- **A Twilio account** with a purchased, voice-capable phone number.
- **A Gemini API key** (for the Gemini Live realtime session).
- **A public HTTPS endpoint** in front of the daemon — Twilio needs to reach it for both the
  answer webhook and the media-stream WebSocket. Any tunnel or reverse proxy works; see
  [`docs/runbooks/deployment.md`](runbooks/deployment.md) for ingress options.

## 2. Install & build

```bash
git clone <repo-url>
cd parley
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package in the workspace, including `@parley/cli`, whose entry point
ends up at `packages/cli/dist/cli.js`. The examples on this page invoke the CLI as
`node packages/cli/dist/cli.js <command>` — that path always works right after a build, with no
extra linking step. (This repo doesn't ship a global `parley` bin link; if you want a shorter
`parley <command>` on your `PATH`, put `packages/cli/dist` on it yourself, or see how
[`docs/runbooks/deployment.md`](runbooks/deployment.md) invokes the same file directly from a
service wrapper.)

## 3. Configure

Copy the example environment file:

```bash
cp .env.example .env
```

`.env` is gitignored — Parley reads secrets and daemon settings only from the process
environment, never from a CLI flag or a committed file. Fill in each variable:

| Variable | What it is | Required? |
|---|---|---|
| `GEMINI_API_KEY` | Gemini Live API key, used for the realtime voice session. | Yes, for `serve`. |
| `TWILIO_ACCOUNT_SID` | Your Twilio account SID. | Yes, for `serve`. |
| `TWILIO_AUTH_TOKEN` | Your Twilio auth token. Also used to verify inbound Twilio webhook signatures. | Yes, for `serve`. |
| `TWILIO_FROM_NUMBER` | The E.164 number Twilio originates outbound calls from, e.g. `+14155550001`. | Yes, for `serve`. |
| `PARLEY_PUBLIC_HOST` | The daemon's public hostname (no scheme), e.g. `voice.example.com`. Given to Twilio as the callback host; also seeds the SSRF-safe host allowlist for inbound webhook and media-stream requests. | Yes, for `serve`. |
| `PARLEY_PORT` | TCP port `parley serve` binds to. | No — defaults to `3334`. |
| `PARLEY_CALLABLE_NUMBERS` | Comma-separated E.164 numbers Parley is allowed to dial, e.g. `+15555550187,+15555550188`. | No — but if unset, the allowlist is empty and **every** call is denied (fails closed). |
| `PARLEY_DAEMON_URL` | Base URL the `parley call` CLI command `POST`s the envelope to. | No — defaults to `http://127.0.0.1:3334`. Only read by `call`, not `serve`. |
| `PARLEY_POST_CALL_COMMAND` | Optional shell command `serve` spawns (detached) after each call completes. | No — and it only fires when `PARLEY_CALL_RECORDS_PATH` is also set; see [`docs/configuration.md`](configuration.md) for that variable and the full reference. |

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `GEMINI_API_KEY` are secrets
— never commit real values.

## 4. Check your config

```bash
node packages/cli/dist/cli.js doctor
```

`doctor` reports presence or absence of the four required secrets
(`GEMINI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) — it never
prints their values, so it's safe to run and paste anywhere. Before `.env` is filled in, it looks
like this:

```
GEMINI_API_KEY: MISSING
TWILIO_AUTH_TOKEN: MISSING
TWILIO_ACCOUNT_SID: MISSING
TWILIO_FROM_NUMBER: MISSING
```

Every line should read `present` before you move on. Note that `doctor` only checks these four —
it doesn't validate `PARLEY_PUBLIC_HOST`, `PARLEY_PORT`, or `PARLEY_CALLABLE_NUMBERS`, so
double-check those by eye.

## 5. Run the daemon

```bash
node packages/cli/dist/cli.js serve
```

This starts `@parley/server`, which throws immediately if any required secret above is missing.
On success it prints `parley daemon listening on :<port>` and stays in the foreground. `serve`
only accepts calls that Twilio can actually reach — your public HTTPS endpoint (see
[`docs/runbooks/deployment.md`](runbooks/deployment.md)) needs to be up and forwarding to
`PARLEY_PORT` on `127.0.0.1` **before** you place a call, since both the answer webhook and the
media-stream WebSocket go through it.

## 6. Place your first call

Use the sample brief in `examples/briefs/represented.json` and dial the number it's written for:

```bash
node packages/cli/dist/cli.js call --to +15555550187 --brief examples/briefs/represented.json
```

Two things to get right here:

- `--to` must match `brief.to` **inside** `examples/briefs/represented.json` exactly — the CLI
  refuses the call otherwise (`--to <x> does not match the brief recipient <y>`). This sample
  brief's `brief.to` is `+15555550187`, so that's the value used above.
- That same number must also be in your `PARLEY_CALLABLE_NUMBERS` allowlist from step 3, or the
  daemon rejects it (fail-closed — see step 3's table).

Before dialing a real number for the first time, it's worth previewing exactly what the model
will be told. The harness's `preview` command prints the assembled `systemInstruction` and
opening line with no telephony or network side effects, and accepts either a bare `Brief` object
(`{ to, persona, objective, facts }`) or a full call envelope like
`examples/briefs/represented.json` — pointing it directly at that file works:

```bash
node packages/cli/dist/cli.js harness preview --brief examples/briefs/represented.json
```

See [`docs/agent-setup.md`](agent-setup.md) for the exact harness commands and the full
offline-validation workflow (including the reliability harness) that's recommended before any
real call.

## 7. What success looks like

`serve` itself only logs its own startup line — it doesn't print a line per call — so watch these
signals instead, in order:

1. `parley call` returns `call queued: <callId>` immediately (it's a thin HTTP client; this
   confirms the daemon accepted the envelope).
2. The number in `TWILIO_FROM_NUMBER` calls the number you passed to `--to`.
3. On answer, there's a brief pause while Twilio opens the media-stream WebSocket and the daemon
   connects to Gemini Live, then the model speaks a short, generic opening line — never the raw
   persona or brief text read aloud.
4. From there it follows the brief: in the `represented.json` sample, that means introducing
   itself as calling on Alex Rivera's behalf and working the rescheduling objective into the
   conversation.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Twilio returns 403 / "bad signature" on the answer webhook | `TWILIO_AUTH_TOKEN` is wrong, or Twilio's request isn't reaching the hostname in `PARLEY_PUBLIC_HOST` unmodified (a proxy rewriting the URL will break signature verification). |
| Webhook or media stream never arrives at the daemon | Your public ingress isn't forwarding to `PARLEY_PORT` on `127.0.0.1` — recheck the tunnel/reverse-proxy setup in [`docs/runbooks/deployment.md`](runbooks/deployment.md). |
| `parley call` fails with a "call refused" / allowlist-style error | The `--to` number isn't in `PARLEY_CALLABLE_NUMBERS`. Add it and restart `serve` (env vars are read at process start). |
| Immediate auth error from `serve` or the call fails right after connecting | Recheck `GEMINI_API_KEY` and the three `TWILIO_*` secrets — rerun `node packages/cli/dist/cli.js doctor` to confirm which are missing. |
| Call connects but there's no audio either direction | Confirm the media-stream WebSocket path is publicly reachable over the same HTTPS endpoint as the webhook — a proxy that forwards HTTP but not WebSocket upgrades will look "connected" while carrying no audio. |

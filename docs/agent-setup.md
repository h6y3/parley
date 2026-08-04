# Agent setup — copy-paste prompts for driving Parley with an AI coding agent

Parley is designed to be installed, configured, and validated by an AI coding agent (Claude Code,
Cursor, or any other AI coding agent with shell access to this repo) rather than by hand. This doc has
three copy-paste prompts: one to install and configure the daemon, one to validate call behavior
offline before any real call, and a reference section for wiring Parley into your own agent as a
tool.

None of the prompts below place a real phone call. Placing a real call is a separate, explicit
step you take only after reviewing the harness output.

## 1. One-shot setup prompt

Paste this to an agent with shell access to a clone of this repo. It runs the idempotent bootstrap
script (`scripts/setup.sh`: checks Node/pnpm, installs dependencies, builds every package,
scaffolds `.env` from `.env.example` if one doesn't exist yet, and runs `parley doctor`), then
walks you through filling in the secrets `scripts/setup.sh` can't fill in for you.

```
You are setting up the Parley voice-call daemon in this repo.

1. Run `bash scripts/setup.sh`.
2. Open `.env` and ask me, one at a time, for each value that's still unset:
   `GEMINI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
   `PARLEY_PUBLIC_HOST`, `PARLEY_CALLABLE_NUMBERS`. Fill them into `.env` exactly as I give them
   to you. Never echo a secret value back to me or write one into a log, commit message, or any
   file other than `.env` itself.
3. Run `parley doctor` and report the result (it never prints secret values, only which
   variables are present or missing).
4. Do NOT place a real call until I explicitly confirm — not even a test call to a number I've
   mentioned in passing.

See `docs/getting-started.md` for the human-readable walkthrough of the same steps.
```

## 2. Harness-prep prompt

Run this **before every real call**, and again any time the brief, policy, or prompt-rendering
code changes. It exercises the exact `systemInstruction` a call would send — offline, with no
telephony or network side effects for `preview`/`scenarios`, and live (but text-only or
scripted-scenario) Gemini calls for `run-text-preview`/`reliability`.

```
Before any real call, validate behavior offline using the Parley harness.

1. Run `parley harness preview --brief examples/briefs/represented.json` and show me the exact
   `systemInstruction` and opening trigger it would send. Read it back to me in full — don't
   summarize it.
2. Run `parley harness scenarios` to list the derail scenarios the harness can exercise
   (topic-change, identity-swap-trap, are-you-an-ai, out-of-brief, hostile, silence,
   commit-beyond-authority, out-of-window-scheduling).
3. If `GEMINI_API_KEY` is set, run `parley harness run-text-preview --brief
   examples/briefs/represented.json` to preview scripted-scenario turns as text (this makes a
   live Gemini call but is not the reliability gate), then run `parley harness reliability
   --brief examples/briefs/represented.json --scenario <id> [--runs <n>]` for the scenario(s)
   most relevant to this call.
4. Summarize whether the model kept the opening line generic, followed the brief, deferred
   correctly on out-of-brief and beyond-authority pushes, and never voiced a structural marker
   (section headers, JSON, role labels) out loud. Report any failure with the exact transcript
   line as evidence, not a paraphrase.

Confirm the exact subcommands and flags with `parley harness --help` before running anything —
don't assume this prompt's flags haven't drifted from the CLI.
```

**Note:** `--brief <path>` accepts either a bare `Brief` object (`{ to, persona, objective, facts }`)
or a full call envelope (`{ version, brief, policy }` — see §3 below); the harness reads the
`brief` field out of an envelope automatically. Either way, the harness previews/exercises the
brief under its own **fixed** representative-mode policy ("calling on Alex Rivera's behalf") — it
does not read or audit the envelope's own `policy`. If you need to verify the exact `policy` a
real call will use, read it directly from the envelope file (§3) — it is validated at call time by
`parseCallEnvelope` (`packages/policy/src/schema.ts`), not by the harness.

## 3. Integrating Parley into your agent

Parley's only inbound interface is `POST /call` on the daemon (`parley serve`, listening on
`PARLEY_PORT`, default `3334`). Any agent framework can drive a call by POSTing a JSON **call
envelope** to that endpoint — there is no SDK, no framework plugin, and no Parley-side coupling to
any particular agent runtime.

**The envelope contract:**

```json
{
  "version": 1,
  "brief": {
    "to": "+15555550123",
    "persona": "I am Ada, calling on behalf of Alex Rivera, Alex's personal assistant.",
    "objective": "Reschedule Alex Rivera's dentist appointment currently set for Friday at 3pm.",
    "facts": ["The appointment is with Dr. Nguyen.", "Alex prefers Monday or Tuesday next week."]
  },
  "policy": {
    "principalName": "Alex Rivera",
    "identity": { "style": "onBehalf", "role": "personal assistant" },
    "disclosure": { "honestIfAsked": true, "volunteer": false },
    "scope": { "lock": true },
    "grounding": { "antiInvention": false },
    "deferral": { "enabled": true },
    "authority": {}
  }
}
```

- `brief` is the pure, per-call assignment content — who's being called, what to accomplish, and
  the facts the model is allowed to use. Nothing else.
- `policy` is validated (and, for `identity`/`disclosure`/`scope`/`grounding`/`deferral`, mostly
  produced) by one of `@parley/policy`'s three presets — `principalCall`, `representedCall`, or
  `transactionalCall` — rather than hand-written. See `examples/agent-integration/README.md` for
  how a prep step derives `policy` from a preset.
- The daemon validates the whole envelope with `parseCallEnvelope` (`packages/policy/src/schema.ts`)
  before doing anything else; a malformed envelope is rejected, not partially applied.

**Minimal reference adapter:** `examples/agent-integration/call.mjs` is the smallest possible
integration — it reads an envelope JSON file and POSTs it to `/call` using only `fetch`, no
Parley package import:

```bash
PARLEY_DAEMON_URL=http://127.0.0.1:3334 \
  node examples/agent-integration/call.mjs examples/briefs/represented.json
```

Use it as the template for your own agent's "place this call" tool: build the envelope from
whatever your agent knows about the task, POST it to `PARLEY_DAEMON_URL`'s `/call` endpoint, and
read back `{ callId }` (or `{ error }` on rejection).

**After the call:** if you want your agent notified when a call finishes, set
`PARLEY_CALL_RECORDS_PATH` (where the daemon appends one JSON line per completed call) and
optionally `PARLEY_POST_CALL_COMMAND` — a shell command the daemon spawns, fire-and-forget, after
each call completes, invoked as `<command> --records-path <path> --call-id <id>`. This hook never
blocks the call path and is the intended place to trigger your own summarizer or follow-up
workflow.

For the full field-by-field schema, every environment variable, and defaults, see
[`docs/configuration.md`](configuration.md).

# Phone testing

`@parley/phone-test` tests Parley over the real phone network with no human on
the line. It buys a temporary Twilio number, answers it with a simulated callee
(a voice bot playing a scripted persona), has your running Parley daemon call
that number, and scores each call on its outcome, its timing and how natural it
sounds. Use it to compare realtime configurations (provider, think model, voice,
speed) on real PSTN audio before a person ever listens.

It complements the offline harness (`parley harness scenario`, `reliability`,
`metamorphic`; see [Scenario Authoring](scenario-authoring.md)) rather than
replacing it: the offline matrix is free and fast, and the phone campaign is
where carrier latency, codec noise and real turn-taking show up. It does not
replace a live call to a person when the shape of a conversation changes.

## How a campaign works

```text
parley campaign run
  │ 1. registers the next call's persona with the sim (loopback control API)
  │ 2. POST /call to your daemon, with an envelope dialling the test number
  ▼
Parley daemon ── Twilio PSTN ──▶ test number
                                   │ voice webhook  https://<public host>/sim/answer
                                   ▼
                       parley sim serve (127.0.0.1:3340)
                         ├ verifies Twilio signatures; rejects every caller but the daemon's
                         ├ media stream ◀▶ callee bot (the provider NOT under test)
                         └ stereo WAV (L = agent as heard, R = callee) + timeline JSON
  ▲
  │ 3. waits for the call to end; reads the capture and the daemon's call record
  │ 4. scores: outcome checks → timing metrics → pairwise judge
  ▼
report.md, results.json and the best recordings
```

Calls are serial, one at a time, on one number. The callee always runs on the
realtime provider that is **not** under test, with a voice distinct from the
agent's, so the two ends are never the same model talking to itself.

## Prerequisites

- **A running Parley daemon, 0.5.0 or later**, reachable from where you run the
  campaign, with `PARLEY_CALL_RECORDS_PATH` set (the runner reads each call's
  record from it) and `PARLEY_CALLABLE_NUMBERS_FILE` set (the campaign adds its
  number there). The daemon reads the variable at startup, so set it and
  restart the daemon once; after that it re-reads the file on every call, and
  the campaign's edits need no restart.
  See [Configuration](configuration.md).
- **A Twilio account that is not a trial account.** Trial accounts play a
  preamble on every call, which breaks timing; `campaign start` refuses them.
  The campaign buys any US local voice number your account can buy and releases
  it at `stop`.
- **A public route to the sim.** Twilio must reach `https://<public host>/sim/*`
  (`/sim/answer`, `/sim/status` and the `/sim/media/…` WebSocket) from the
  public internet, forwarded to `127.0.0.1:3340`. Add a path rule to whatever
  already fronts the daemon — a reverse proxy, or a tunnel (for example a
  cloudflared ingress rule with `path: ^/sim/` and
  `service: http://127.0.0.1:3340`, placed before the daemon's rule for the same
  hostname). Route `/sim/` only: the sim's `/control/*` API is loopback-only and
  refuses forwarded requests.
- **Keys for both realtime providers** you use: `GEMINI_API_KEY` and/or
  `DEEPGRAM_API_KEY`. Comparing a Deepgram configuration needs a Gemini callee,
  and the reverse.

## Scenarios, personas and configurations

A **phone scenario** is a JSON file (examples in
`packages/phone-test/scenarios/`, for instance `dental-reschedule.json`):

- `id`, `description`.
- `job`: the call Parley is asked to place — the envelope's `brief`, `policy`
  and optional `execution`. `brief.to` is a placeholder; the runner replaces it
  with the campaign's number.
- `personas`: the people the callee plays. Each has a `name` (a slug), a
  `role` ("the front-desk scheduler at a dental office"), `facts` it holds
  (slots, prices), `behaviours` in order (quoted lines are said verbatim: "ask
  about insurance before booking", "interrupt the agent's first explanation")
  and `endsCallWith`, the line after which it says goodbye. Two optional
  fields: `answerStyle` (`"realistic"`, the default, or `"instant"`; see
  [How the callee answers](#how-the-callee-answers)) and `diagnostic`
  (`true` keeps the persona out of a run unless `--include-diagnostic` is
  given).
- `expect`: the outcome a correct call reaches against every persona — a
  `status` and, per outcome field, a list of accepted forms (a recorded value
  matches when it contains any one, case-insensitively).

The sample scenarios reschedule Jordan Rivera's dental cleaning, placed by Ava.
`dental-reschedule.json` runs three personas as plain two-party calls (no IVR
declared): `cooperative`, `insurance-and-odd-time` and `interrupter`. A fourth,
`instant-hello`, is diagnostic: it is `cooperative` with `answerStyle:
"instant"`, and measures how an agent copes with a greeting that arrives the
instant the line opens. `dental-menu.json` is the same job with
`execution.ivr` declared and one persona, `menu-first` (a phone menu before a
person). It is a separate scenario because declaring an IVR changes the agent's
behaviour (for one, the missed-greeting nudge is skipped), and real jobs
declare one only when a menu is expected.

### How the callee answers

A person picks up, pauses, says hello, and says "Hello?" again if nobody
answers. The sim plays it that way by default (`answerStyle: "realistic"`):

- **Pickup pause.** The callee speaks 1.2 s after the media stream starts, not
  the moment it opens.
- **Reprompt.** Once the callee has spoken, if the line then goes quiet both
  ways for 3 s (no callee audio still playing, no voiced audio from the agent)
  and the agent has not spoken at all on the call, the callee says "Hello?"
  again, at most twice. Each one is marked `callee-reprompt` in the call's
  timeline. Once the agent has spoken, the callee never reprompts.

`answerStyle: "instant"` skips both: the callee speaks as soon as the line
opens and never repeats itself. Use it to measure the risk, not to compare
configurations: that is why the sample's `instant-hello` is `diagnostic`.

### Diagnostic personas

A persona with `"diagnostic": true` measures a specific risk rather than taking
part in a decision. `campaign run` skips it (and logs that it did) unless
`--include-diagnostic` is given, so a decision run's rates are never mixed
with a diagnostic's. Run diagnostic personas in a run of their own.

A **configuration file** (examples in `packages/phone-test/configs/`) is a list
of named per-call realtime settings, each an `execution.realtime` block (see
[Per-call realtime settings](configuration.md#per-call-realtime-settings)):

```json
[
  { "name": "gemini-default", "realtime": { "provider": "gemini" } },
  { "name": "deepgram-haiku", "realtime": { "provider": "deepgram", "think": "claude-haiku-4-5" } }
]
```

A run places scenarios × personas × configurations × `--calls-per-cell` calls
(diagnostic personas only with `--include-diagnostic`).

## Commands

Every setting and secret comes from the environment, never from a flag. Load an
env file with Node:

```bash
node --env-file /path/to/.env packages/cli/dist/cli.js campaign status
```

| Command                                                                                                                        | Needs                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parley campaign status [--state-dir <dir>]`                                                                                   | nothing                                                                                                                                                                                                                                       |
| `parley campaign start [--budget 50] [--state-dir <dir>]`                                                                      | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `PARLEY_PUBLIC_HOST`, `PARLEY_CALLABLE_NUMBERS_FILE`, `GEMINI_API_KEY`                                                                                                       |
| `parley campaign run --scenarios <file…> --configs <file> --calls-per-cell <n> [--judge] [--include-diagnostic] [--out <dir>]` | `PARLEY_DAEMON_URL` (no default), `PARLEY_CALL_TOKEN`, `PARLEY_PUBLIC_HOST`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, each callee provider's key, `PARLEY_CALL_RECORDS` (else `PARLEY_CALL_RECORDS_PATH`); `--judge` needs `GEMINI_API_KEY` |
| `parley campaign stop [--state-dir <dir>]`                                                                                     | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PARLEY_CALLABLE_NUMBERS_FILE`                                                                                                                                                                     |
| `parley sim serve [--callee-provider gemini\|deepgram] [--callee-voice <name>] [--port 3340] [--out <dir>] [--caller <E.164>]` | `PARLEY_PUBLIC_HOST`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (unless `--caller`), the callee provider's key                                                                                                                                |

`start` and `run` spawn and replace the sim themselves; `sim serve` is for
running it by hand. The sim answers only calls from the daemon's caller number
(`--caller`, else `TWILIO_FROM_NUMBER`, the same variable the daemon dials from)
and rejects any other caller with `<Reject/>` before it can take a persona: a
newly bought number draws stray calls, and each answered one would be billed. The state directory defaults to `~/.config/parley`, holding
`test-campaign.json` (the campaign: number, SID, start time, budget),
`test-spend.jsonl` (the spend log) and the sim's pid and log, all mode 600.

The sequence is always `status` → `start` → `run` (as many times as needed) →
`stop` → `status`:

1. **`status`** shows the active campaign (if any), its number and age,
   month-to-date spend and the remaining budget.
2. **`start`** refuses if a campaign exists, the month's budget cannot cover the
   number's fee, or the account is a trial. It writes a `pending` state, buys
   one number (FriendlyName `parley-test-campaign`), points its voice URL at
   `https://$PARLEY_PUBLIC_HOST/sim/answer`, adds it to the callable-numbers
   file and starts the sim. It then checks the public route the way Twilio will
   use it, `https://$PARLEY_PUBLIC_HOST/sim/healthz`, for up to a minute. Any
   failure rolls back (the number released, its line removed, the sim
   stopped); a public route that never answers usually means the `/sim/` path
   rule is missing or placed after the daemon's.
3. **`run`** places the calls serially. Before each, it checks that month-to-date
   spend plus that call's worst case still fits the budget, and refuses to dial
   any number but the campaign's. After each, it books the call's estimated cost
   to the spend log. Every call is bounded three times over: its envelope's
   `limits.maxDurationSeconds` is capped at 300 s (whatever the scenario says),
   the runner hangs up at 300 s, and the sim ends any call it has held for
   330 s. `--judge` needs exactly one Gemini configuration, the
   reference the others are compared with. Diagnostic personas are skipped
   unless `--include-diagnostic` is given. A run that fails keeps what it placed.
4. **`stop`** is idempotent and safe after a crash, working from the state file
   alone: it releases the number (a 404 counts as already released; a `pending`
   state sweeps every number with the campaign's FriendlyName), removes it from
   the callable-numbers file, stops the sim and deletes the state file. Once
   Twilio confirms the release, the state is marked `released` before any local
   edit, so a failure after that point never leaves a dialable campaign; run
   `stop` again to finish. An unreadable state file is reported only after the
   FriendlyName sweep has run.

**A campaign always ends with `stop`.** If anything is interrupted, run `stop`
before anything else; `status` warns once a campaign is over 48 hours old.

Output goes to `--out`, else `$PARLEY_TEST_OUT_DIR/<campaign>/` when that
variable is set (a leading `~/` is your home directory), else
`./parley-tests/<campaign>/`: `report.md`, `results.json`, the captures, the
best recordings and a `calibration/` pack.

## Scoring

The checks run in order of trust, and every failure gets a typed code, as in
the offline harness. Read the report as failure rates per code, not as a pass
count.

### Outcome, from the daemon's call record

| Code                  | Meaning                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `outcome-missing`     | no outcome recorded                                                                                                                 |
| `outcome-status`      | the status differs from `expect.status`                                                                                             |
| `unsupported-outcome` | a field's value matches none of its accepted forms                                                                                  |
| `placeholder-name`    | a who-confirmed field holds a role ("the receptionist") instead of a name                                                           |
| `not-ended-by-model`  | a `completed` call that the model did not end                                                                                       |
| `voice-dropped`       | the realtime session closed unasked (`realtimeClose` on the record)                                                                 |
| `persona-violation`   | the callee broke character (said it is an AI); the call is excluded, not counted, and its cell is rerun once (if the budget allows) |

### Timing, from the stereo capture

A per-channel energy VAD, relative to each channel's noise floor so line hiss
is not read as speech, turns each channel into speech segments. Thresholds are
in `packages/phone-test/configs/thresholds.json`; the defaults are starting
points, to be recalibrated against people listening.

| Code                   | Fails when                                                                         | Default        |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------- |
| `slow-response`        | response gap (callee stops → agent starts) p50 or p90 too high                     | 1500 / 2500 ms |
| `spoke-before-callee`  | the agent spoke before the callee's first speech                                   | —              |
| `talk-over`            | an overlap the agent started (speaking over the callee) exceeds                    | 300 ms         |
| `slow-barge-in`        | the callee interrupts (≥ 600 ms of speech) and the agent keeps talking longer than | 800 ms         |
| `talked-after-goodbye` | agent speech after the callee's goodbye exceeds                                    | 1500 ms        |
| `dead-air`             | mutual silence mid-call exceeds                                                    | 4000 ms        |
| `callee-reprompted`    | the callee had to say "Hello?" again (any `callee-reprompt` on the timeline)       | —              |

A reply the agent starts just before the callee finishes, overlapping by no
more than the `talk-over` threshold, counts as a response gap of 0 rather than
being dropped, so fast endpointing is not penalised in p50. A shorter overlap
the callee starts is a backchannel ("mm-hmm"), which the agent is right to talk
through. Agent audio within 300 ms of its own keypad tones is
not counted as speech.

`callee-reprompted` (with the call's `repromptCount`) is the only trace of an
agent that left the callee's hello unanswered: the reprompt comes after 3 s,
before `dead-air` can fire, and the callee speaking again drops the unanswered
response gap. It is a timing code read from the timeline, but the report counts
it as an **outcome failure**.

### Runner and harness codes

`call-timeout` (the call ran past the 300 s ceiling and was hung up — counted
against the agent), and `sim-unreachable`, `persona-missing`,
`record-missing`, `dial-refused`, `dial-failed`, `sim-desync` and
`budget-stop`, which are the harness's own failures: those calls, and calls
whose capture could not be analysed (`capture-missing`), are excluded from
every rate and listed separately.

### The judge

With `--judge`, each non-reference call is paired with the reference
configuration's call of the same scenario, persona and index. A Gemini audio
model hears both calls — each channel as its own mono file, plus the transcript,
because stereo would be mixed down — and says which call's agent sounds more
like a natural human assistant (voice, wording, turn-taking), with a confidence
and a one-line reason. Every pair is judged in both orders; a configuration wins
a pair only when both orders pick it, which cancels position bias.

**Self-preference caveat.** The judge is a Gemini model, and Gemini is one of
the contestants. The report says so, and its win rates are a ranking aid, not a
verdict: people listening to the finalists break ties. The `calibration/` pack
holds up to six blind pairs with an `answers.txt` for a listener, so the judge
can be checked against human ears.

### The report

`report.md` gives, per configuration: calls, exclusions, outcome-failure rate
(any outcome code, a `call-timeout`, or `callee-reprompted`),
`talk-over` and `spoke-before-callee` rates, response-gap p50/p90, judge win
rate and cost. A non-reference configuration is a **finalist** only if, on the
cells it shares with the Gemini reference, its outcome-failure rate is no
higher, its p50 response gap is within the reference's + 200 ms, its
`talk-over` and `spoke-before-callee` rates are no higher, and the judge prefers
it in at least 60% of order-agreed pairs. The best recordings of the top two
finalists and of the reference are copied beside the report; with no finalist
(or no judge), the best configurations by timing and outcome are copied
instead.

Calls with a diagnostic persona (run with `--include-diagnostic`) are listed in
the report's **Diagnostic** section, with their codes and reprompt counts, and
nowhere else: they are in no rate, judge pair or decision.

## Costs

The campaign books each call's estimated cost from its duration; set the rates
to your own account's prices in `RATES_USD_PER_MIN`
(`packages/phone-test/src/spend.ts`). Per call:

```text
cost = ceil(minutes) × ( outbound + inbound + 2 × media_streams )
     + minutes       × ( agent_realtime_rate + callee_realtime_rate )
```

`minutes` is the call's length rounded up to 0.1; the carrier legs are billed
per started minute, hence the `ceil`. Every estimate errs high:

- `outbound`: your carrier's per-minute rate for the daemon's call out;
- `inbound`: its rate for the test number answering;
- `media_streams`: the per-minute streaming rate, twice, because both ends
  stream;
- `agent_realtime_rate`: the agent provider's per-minute rate for the
  configuration in use. A Deepgram configuration is priced at the Standard tier
  only when its `think` model is one known to be Standard (`gpt-4o-mini`,
  `gpt-4.1-mini`, `gpt-5.4-mini`, `claude-haiku-4-5`, `gemini-3.5-flash`);
  any other model, or no `think` (the daemon's default, which the harness
  cannot see), is priced at Advanced;
- `callee_realtime_rate`: the callee provider's rate. A Deepgram callee thinks
  with the daemon's configured model, so it is always priced at Advanced.

Before each call, the worst case — the 300 s ceiling plus a 30 s capture wait,
5.5 minutes — must fit under the budget (`--budget`, a monthly cap in USD,
default 50, checked against the calendar month's spend in UTC). A call that
may have been placed but cannot be followed (a lost or id-less `POST /call`
response) is booked at that worst case. The number's monthly fee
(`NUMBER_MONTHLY_USD`, $1.15) is booked as `number-fee` the moment `start` buys
it, and `start` refuses when the fee would pass the budget. With `--judge`,
each judge request (two per pair, one per order) is booked as `judge` at a
fixed estimate, `JUDGE_REQUEST_USD` (`packages/phone-test/src/cli.ts`).

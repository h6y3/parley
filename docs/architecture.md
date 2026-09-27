# Architecture

Parley is a long-running Node.js service (the **daemon**, `@parley/server`) that can also be
used as a set of libraries directly. The daemon exposes three surfaces: a local HTTP API for
originating calls, a Twilio webhook for call-answer callbacks, and a WebSocket endpoint for the
Twilio media stream. Internally, a `CallSession` orchestrator in `@parley/core` owns the
lifecycle of a single call end-to-end: assembling the prompt, driving the telephony provider,
driving the realtime provider, and bridging audio between them.

## Dataflow

```
 consumer (CLI / your app / examples/agent-integration adapter)
   │
   │  POST /call  { version, brief, policy }
   ▼
┌───────────────────────────────────────────────────────────────┐
│                    @parley/server (daemon)                     │
│                                                                 │
│   HTTP /call ───────► CallSession orchestrator (@parley/core)  │
│                          │                                      │
│                          │ 1. compose guardrails from policy    │
│                          │    (@parley/policy)                   │
│                          │ 2. render systemInstruction            │
│                          │    (persona → rules → guardrails)      │
│                          │ 3. pick the one-line opening trigger   │
│                          │                                        │
│              ┌───────────┴────────────┐                          │
│              ▼                        ▼                          │
│   TelephonyProvider          RealtimeProvider                    │
│   (@parley/telephony-twilio) (@parley/realtime-gemini)           │
│              │                        │                          │
└──────────────┼────────────────────────┼──────────────────────────┘
               │                        │
               ▼                        ▼
  ┌─────────────────────┐    ai.live.connect({ systemInstruction, ... })
  │ Twilio                │        │
  │  - originate()        │        │ sendOpeningTrigger(shortLine)
  │  - webhook → TwiML    │        │   via send_realtime_input
  │  - media-stream WS    │        │
  └──────────┬────────────┘        ▼
             │ 8kHz μ-law   ┌──────────────────────┐
             │ frames (in)  │ Gemini Live session    │
             ▼              │  gemini-3.1-flash-     │
  ┌───────────────────────┐ │  live-preview          │
  │  Audio bridge           │◄┤  responseModalities:  │
  │  (@parley/audio)        │ │  ["AUDIO"]             │
  │                          ├►│  24kHz PCM out         │
  │  in:  μ-law → 16kHz PCM  │ └──────────┬─────────────┘
  │  out: 24k→8k μ-law,      │            │
  │  single ÷3 averaging     │            │ onInterrupted (barge-in)
  │  (boxcar) decimation —   │◄───────────┘
  │  not naive downsample    │
  │  on interrupted: clear    │
  │  local buffer + send      │
  │  Twilio `clear` command   │
  └──────────┬────────────────┘
             │ 8kHz μ-law frames (out)
             ▼
        back to Twilio media WS → PSTN → recipient's phone
```

Both audio directions cross the same bridge: caller speech flows up the left side (Twilio →
resample → Gemini), model speech flows down the right side (Gemini → resample → Twilio), and a
barge-in event flowing out of the Gemini session fans out to both the audio bridge's local buffer
and a `clear` command sent back down to Twilio — stopping playback at both layers, not just one.

The `systemInstruction` and the opening-trigger call happen exactly once each, at the top of the
diagram, before any audio flows. Nothing in this dataflow allows the brief to re-enter as a
conversational turn later in the call — see `docs/prompt-guide.md` for why that boundary is
enforced at the interface level, not just by convention.

A call declaring an `execution` block adds one further arrow to this diagram, in both directions:
the model may request a tool call, and the server answers it. That is the model _acting_, not
being re-instructed, and the answer it reads back is drawn from a fixed union of string literals
rather than composed from anything said on the call. See `docs/security-model.md` for the gating
rules and the threat they exist for.

### Two planes, and a handoff between them that only runs once

Everything above is the **speaking plane**: audio flows both ways, and a `RealtimeProvider`
session is what a caller on the other end hears and is heard by. A call whose `execution` block
declares `meeting` can additionally reach the **listening plane** — a `TranscriptionProvider`
session with no way to put audio, or anything else, back onto the call. The two planes are never
both live: the speaking plane is what a meeting uses to obtain consent, and the moment consent is
granted, `CallSession.beginNotetaking()` swaps one for the other and does not swap back.

```
execution.meeting.consent — "model proposes, server disposes" (docs/security-model.md
#meeting-notetaking--consent-not-absence-of-capture)
   │
   │ ToolGate.authorizeNotetaking(): the declared phrase, heard from a NON-model speaker,
   │ after at least one completed model turn
   ▼
CallSession.beginNotetaking()
   │ 1. build ConsentReceipt from the pre-consent buffer (announcement + request + go-ahead),
   │    THEN empty the buffer and clear the consent timer — nothing in it survives past this
   │ 2. connectTranscription(), bounded by TRANSCRIPTION_CONNECT_TIMEOUT_MS (10s) — the provider's
   │    connect() resolves on `open` and rejects on `error`, but settles on NEITHER if the socket
   │    just never answers, so beginNotetaking() would otherwise never return
   ▼                                              ▼ (connect fails or times out)
listening plane is live              onDiagnostic(...) + endCall("transcriptionLost")
   │                                  — a live, billing call that can no longer take notes ends
   │                                    rather than sits open pretending to
   │
   │ 3. addSink("transcription") — every inbound frame goes through AudioBridge.adapt(): a
   │    pass-through if the source already speaks an encoding the provider accepts, one
   │    convert() call if not (accepts[0] is the target; @parley/audio supplies convert)
   │ 4. removeSink("realtime"), leavePhase("speaking") → enterPhase("listening")
   │ 5. the RealtimeSession (speaking plane) is closed — listening comes up BEFORE speaking
   │    goes down, so no window exists where audio reaches neither plane
   ▼
TranscriptionSession.sendAudio(frame) ──► TranscriptEvent (finals only, interims dropped)
   │
   ▼
packages/cli/src/transcript-writer.ts ──► meetings/{YYYY-MM-DD}/{callId}/transcript.jsonl
                                           (mode 0600, in a mode-0700 directory) — shape and
                                           consumer contract: docs/configuration.md
                                           #on-disk-layout-once-a-meeting-completes,
                                           schema/transcript.schema.json
                                       + a MeetingRecord (`kind: "meeting"`) appended to
                                         PARLEY_CALL_RECORDS_PATH — see
                                         docs/configuration.md#meetings--the-listening-plane
```

A frame that arrives while `listening.ready` is `false` — most visibly during the connect window
in step 2 — is **dropped, not buffered**, and the drop is recorded as a `TranscriptGap`
(`{fromMs, toMs, reason}`) rather than silently absorbed. Buffering would produce an unbounded
queue against a carrier that delivers 50 frames a second for up to four hours, and a transcript
that arrives minutes late is worse than one with a recorded hole. A reader of the finished meeting
sees exactly how much of it was actually covered
(`CompletedCallRecord.gaps`/`gapMs`/`coveredMs`), never a readout that looks complete over a hole
it doesn't name.

**Slice A does not reconnect the listening plane, and this section used to imply it did.** There
is no backoff, no retry and no resume: `TranscriptionConnectParams` deliberately models no resume
point, no shipped provider retries, and `CallSession` treats the transcriber's `onClose` as
terminal — it ends the call as `transcriptionLost`, because after the handoff taking notes is the
call's only remaining purpose and sitting on a live, billing call that is no longer taking any is
the outcome that must not happen.

Two consequences follow, and a consumer of the artifacts cannot see either one from the artifacts
themselves:

- **A `transcriber_not_ready` gap is effectively unreachable in production.** The only window it
  can open in is the handful of frames between a socket close setting `ready` false and `endCall`
  clearing the sinks. The gap a real meeting records is `transcriber_connecting` — the handoff
  window, typically a few hundred milliseconds.
- **So `gapMs` is small on a real meeting**, and a downstream rule of the form "degrade the readout
  if more than N% of the meeting is missing" will effectively never fire in slice A. The signal
  that notes stopped is not `gapMs` but `endedReason: "transcription_lost"` on the meeting record.
  That is the field to branch on. **This is a property of THIS plane, not of the field**: a
  browser meeting (`transport: "browser"`, `@parley/meeting-browser`) measures its coverage
  window from the instant its audio capture began, so a capture that died mid-meeting reports the
  rest of the meeting as gap, and one that never started reports the whole meeting that way. A
  consumer reading both transports must not carry "gapMs is always small" across.

Implementing the spec's backoff/alert/hangup ladder is a slice-B-or-later change, tracked as a
divergence rather than silently carried as prose that describes behaviour the code does not have.

A call declaring no `execution.meeting` block never reaches any of this: `beginNotetaking` is
never called, the listening plane never exists, and the call's only artifact is the ordinary
`CompletedCallRecord` — byte-identical to a call before the listening plane existed.

## Call lifecycle & coordination (Milestone 3)

A Twilio outbound call is three asynchronous events — origination, the answer webhook, and the
media-stream WebSocket — that must converge on **one** `CallSession`. The correlation key is the
Twilio **CallSid**, carried end to end. The server holds a `pendingSessions` map (`Map<CallSid,
CallSession>` — see `packages/server/src/pending-sessions.ts`) — an ordinary instance field on the
server object, **not** a module-level singleton (no global mutable state; V1's single-call limit
and later concurrency are both honoured by this).

```
parley call ──POST /call {brief}──► @parley/server
  1. validate brief.to against the callable-number allowlist (fail closed)
  2. build CallSession(telephony, realtime, codec, registry, brief)
  3. session.originate()  → Twilio REST → CallSid (Twilio's providerCallId)
  4. pendingSessions.set(CallSid, session);  respond 202 { callId: CallSid }

Twilio dials; callee answers ──POST /twilio/answer (form-encoded + X-Twilio-Signature)──►
  5. host-allowlist check first, then verifyWebhookSignature — FAIL CLOSED; fullUrl
     reconstructed from the configured HOST ALLOWLIST, never from Host / X-Forwarded-Host
     headers
  6. session = pendingSessions.get(CallSid from the form body)   (404 → no pending call if absent)
  7. return session's TelephonyProvider.buildAnswerResponse TwiML:
        <Connect><Stream url="wss://HOST/media/{CallSid}"/></Connect>

Twilio opens the media WS to /media/:callId ──►
  8. host-allowlist check on upgrade (from the Host header, checked against the same
     allowlist); session = pendingSessions.get(callId)  (socket destroyed if absent)
  9. wrap the `ws` socket as WebSocketLike; call session.attach(callId, socket)
 10. CallSession attaches the media stream FIRST (registers the socket listener), THEN awaits
     realtime.connect(); the provider parses `start` (captures streamSid), `media` →
     AudioFrame{mulaw8k}; the opening trigger ("Begin the call naturally now.") is sent once
     connect resolves
 11. `close` on the media socket → pendingSessions evicts the entry and the session's stop() runs
     FIRST — sealing any gap still open and flushing the listening plane, both of which the
     record has to describe (packages/server/src/media-connection.ts)
 12. THEN, if configured, the server calls its `onCallCompleted` hook with the record built from
     that torn-down session, and awaits it. The CLI daemon uses this hook to write
     transcript.jsonl and append a JSONL call record before starting an optional post-call
     command, so nothing races the files that command is handed.
```

The order in 11/12 is load-bearing and used to be the other way round. `endCall` seals an open
gap and flushes the listening plane, and a record built before it ran reported `gaps: []`,
`gapMs: 0` over a real hole and was missing the meeting's last utterance — while the hook had
already written both to disk.

**Why URL-path correlation.** Putting the `CallSid` in the media-stream URL path
(`/media/{CallSid}`) correlates the WebSocket to its `CallSession` at HTTP-upgrade time — before
any audio flows — so `attach()` never races the first inbound frame. `AnswerResponseParams` is
already per-call in the `TelephonyProvider` interface, so the server simply constructs
`wss://HOST/media/{CallSid}` when building the answer response in `handleAnswer`
(`packages/server/src/request-handler.ts`). No `@parley/core` change was needed to support this.

**Post-call records and callbacks.** Parley itself has no dependency on any
calling agent, but the daemon exposes an optional post-call hook: if
`PARLEY_POST_CALL_COMMAND` is set, the daemon spawns that command after each
call, passing the records path and the call id. A consumer can use this hook
to run its own summarizer — e.g. to post a transcript summary into a chat
channel or a follow-up system. The hook is fire-and-forget and never blocks
the call path.

**Attach-before-connect ordering.** `CallSession.attach` registers the media-stream listener
_before_ awaiting `realtime.connect()`. This matters: the carrier opens its media socket and
emits its one-time `start` frame (which carries the `streamSid` every outbound message needs)
immediately, and a WebSocket buffers nothing before a listener exists — so awaiting the
realtime connect round-trip first would drop `start` and the call would be silent outbound.
Inbound audio arriving before the session is ready is harmlessly ignored (the callee has not
been prompted to speak yet). As defence in depth, `attachTwilioMediaStream` also captures
`streamSid` from `media` frames, not only from `start`. (Both were found at the M3 live gate;
no offline test exercises the carrier's frame timing.)

**Outbound pacing.** Twilio plays outbound audio on a bidirectional `<Connect><Stream>` at the
real-time telephony rate and silently drops audio delivered faster than real time. A
native-audio model emits speech in large, faster-than-real-time bursts, so the provider buffers
the μ-law and drains it through a 20 ms / 160-byte-frame pacer (with μ-law silence as keep-alive
while idle), matching Twilio's reference cadence. Barge-in (`clearOutboundBuffer`) drops the
queued audio and sends Twilio a `clear` so both layers stop together. Without this pacing the
callee hears nothing — another live-gate finding.

## Keypresses are audio

`press_digits` puts DTMF tones into the **outbound audio stream the call is
already on** — the standard row/column frequency pair, generated by
`@parley/audio` and written through `MediaStreamHandle.sendOutboundAudio`. It
hangs off `AudioCodec.dtmfTones`, not off `TelephonyProvider`, because it is
signal generation and because that keeps `@parley/core` free of DSP.

**`TelephonyProvider` has no `sendDtmf`, deliberately.** It had one, and Twilio's
implementation posted

```xml
<Response><Play digits="1"/></Response>
```

to `POST /Calls/{sid}.json`. Posting TwiML **redirects** a live call rather than
adding to it: every keypress tore down the `<Connect><Stream>` carrying the
conversation, played the tone to nobody, ran off the end of the new one-verb
document, and Twilio hung up. Press a key, lose the call. There is no
non-destructive REST way to send DTMF on a call inside a media stream, and
there does not need to be — a telephone keypad has always worked by putting two
sine waves into the audio path.

The method was removed rather than fixed. One that hangs up the call is a trap,
and leaving it beside the working path would have left both.

## Ending a call without talking over yourself

Outbound audio is paced at 20 ms a frame and the carrier holds a playout buffer
of its own, so at the moment the model calls `end_call` its closing sentence is
still in flight. Hanging up there cuts it off mid-word.

`MediaStreamHandle.drainOutbound(timeoutMs)` waits for the locally queued frames,
sends a Twilio `mark`, and resolves when the carrier echoes it back — the
carrier's own confirmation that it has played everything ahead of that point.
The timeout bounds a confirmation that never arrives; it is never the thing
being waited for.

`CallSession.endCall` awaits it for **`model`** hangups only. A duration cap
firing is not a goodbye, and a dead transport has nothing left to play; neither
is worth holding a live, billing call open for.

## The listening plane has no way to talk back — on purpose, and in the type

`TranscriptionSession` (`packages/core/src/transcription.ts`) has `ready`, `sendAudio`, `flush`,
and `close`. It has no `sendOpeningTrigger`, no method that accepts a `ToolResult`, nothing that
could put a single byte of outbound audio onto the call. This is the same shape of decision as
`TelephonyProvider` having no `sendDtmf` above: a capability was left out of an interface rather
than merely left unused, because leaving it merely unused would not have held.

Consider what "merely unused" would mean here. `beginNotetaking()` closes the speaking plane's
`RealtimeSession` at the same moment it opens the listening plane — see "Two planes, and a
handoff between them that only runs once" above — so at runtime there genuinely is no live model
turn left to speak through once notetaking begins. But that fact holding _today_ is not the same
guarantee as it being _impossible_. A future change to `beginNotetaking` — a bug, a well-meant
"let the agent say one more thing before it goes quiet" feature — could reintroduce a path where
the listening plane is live and something still holds a reference capable of generating outbound
audio. If `TranscriptionSession` had, say, an unused `sendAudioOut` method sitting beside `ready`
and `sendAudio`, that path would compile. The type would not object even though the entire reason
the listening plane exists is that the room was told, out loud, that notetaking had started and
the agent had gone quiet.

Because the type carries no such method, that mistake cannot compile. `TRANSCRIPTION_PLANE_HAS_NO_OUTBOUND`
(`packages/core/src/transcription.ts`) is a marker export whose only job is to be a greppable
anchor for this reasoning — the guarantee itself is enforced by the absence of a method, not by
the constant, and not by a runtime check anywhere. As the code that performs the handoff puts it
at the point it removes the speaking-plane sink: "There is no outbound sink on a
`TranscriptionSession`, so from here the compiler is what keeps the agent quiet." That is the same
family of argument `docs/security-model.md` makes about `RealtimeProvider` having no
general-purpose "send a turn" method — a security property stated as an absence in the interface
lives past the author who reasoned about it once, in a way a comment or a runtime guard does not.

## Component map

| Layer                            | Package                                                                                                                                                                                                                        | Depends on                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration                    | `@parley/core` (`CallSession`, prompt rendering, redaction)                                                                                                                                                                    | Nothing provider-specific — only its own `TelephonyProvider` / `RealtimeProvider` / `AudioCodec` / `WebSocketLike` interfaces                                                                           |
| Policy                           | `@parley/policy` (`CallPolicy`/`CallEnvelope` schema, `composePolicy` guardrail composition, presets)                                                                                                                          | Nothing from `@parley/core` — deliberately decoupled; `CallEnvelope`'s `brief` shape is its own zod schema, not the `@parley/core` `Brief` type                                                         |
| Audio resampling                 | `@parley/audio` (μ-law ⟷ PCM; inbound 8k→16k linear resample, outbound single ÷3 averaging decimation 24k→8k)                                                                                                                  | Nothing (standalone-usable)                                                                                                                                                                             |
| Telephony                        | `@parley/telephony-twilio`                                                                                                                                                                                                     | `@parley/core`'s interfaces                                                                                                                                                                             |
| Realtime (speaking plane)        | `@parley/realtime-gemini` (default `RealtimeProvider`)                                                                                                                                                                         | `@parley/core`'s interfaces, `@google/genai`                                                                                                                                                            |
| Realtime (speaking plane, spike) | `@parley/realtime-deepgram` — a second `RealtimeProvider`, selected by `parley serve --realtime-provider deepgram` (default remains `gemini`); verdict "needs more work", see `docs/decisions/2026-08-19-voice-agent-spike.md` | `@parley/core`'s interfaces                                                                                                                                                                             |
| Transcription (listening plane)  | `@parley/transcription-deepgram` — a `TranscriptionProvider` over Deepgram's Listen API                                                                                                                                        | `@parley/core`'s interfaces. A dependency of `@parley/cli`, which wires it into `parley serve` via `buildTranscription()` — see "Meetings — the listening plane" in `docs/configuration.md`             |
| Daemon                           | `@parley/server` (plain `node:http` + `ws`, no web framework)                                                                                                                                                                  | `@parley/core` + `@parley/policy` + the telephony and (speaking-plane) realtime provider packages. `ParleyServerConfig`/`ServerDeps` also accept an optional listening-plane `transcription` dependency |
| CLI                              | `@parley/cli` (`parley serve`, `parley call`, `parley harness …`, `parley doctor`; optional post-call command hook)                                                                                                            | all of the above, plus `@parley/realtime-deepgram`                                                                                                                                                      |
| Reliability                      | `@parley/harness`                                                                                                                                                                                                              | `@parley/core`, `@parley/policy`, `@parley/realtime-gemini`                                                                                                                                             |

`CallSession` (built in Milestone 2, unchanged in Milestone 3) depends only on the three injected
interfaces — `TelephonyProvider`, `RealtimeProvider`, `AudioCodec` — and exposes
`resolveSystemInstruction()`, `originate()`, and `attach(callId, socket)`. Milestone 3 is
additive: it implements the interfaces (`@parley/telephony-twilio`, already-existing
`@parley/realtime-gemini`) and wires a daemon (`@parley/server`) and a unified CLI
(`@parley/cli`) around them. **No changes were made to `@parley/core` in Milestone 3** — a change
there would have been a design smell to escalate, not something this milestone needed.

The meeting/listening-plane work described above touches `@parley/core` directly (`CallSession`
gains `transcription` as a fourth optional injected dependency, alongside the original three) and
ships `@parley/transcription-deepgram` as a standalone, `@parley/core`-only package — same shape
as every other provider package. `@parley/server`'s `ParleyServerConfig` gains a matching optional
`transcription` field, threaded through to `CallSession` in `request-handler.ts`; `@parley/cli`'s
`serve()` builds one from `DEEPGRAM_API_KEY` (`buildTranscription()`, called unconditionally on
every `serve` run — meeting support stays optional, so this reads the variable directly rather than
`requireEnv`-ing it) and passes it in. **What is enforced, not merely wired:** `request-handler.ts`'s
`handleCall` refuses a meeting envelope with `503` at `POST /call` — before origination, before any
carrier cost — whenever `deps.transcription` is absent, rather than letting `CallSession` discover
the gap only after `beginNotetaking()` is called and consent has already been granted. A caller who
embeds `@parley/core` directly (the pattern `examples/express-minimal` demonstrates for the two
original interfaces) can still supply its own `TranscriptionProvider`; `parley serve` now can too.
See `docs/configuration.md`.

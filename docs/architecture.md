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
 11. `close` on the media socket → the session's stop() runs and pendingSessions evicts the
     entry (packages/server/src/media-connection.ts)
 12. If configured, the server calls its `onCallCompleted` hook with `{callId, endedAt,
     transcript}`. The CLI daemon uses this hook to append a JSONL call record and start an
     optional post-call command.
```

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
*before* awaiting `realtime.connect()`. This matters: the carrier opens its media socket and
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

## Component map

| Layer | Package | Depends on |
|---|---|---|
| Orchestration | `@parley/core` (`CallSession`, prompt rendering, redaction) | Nothing provider-specific — only its own `TelephonyProvider` / `RealtimeProvider` / `AudioCodec` / `WebSocketLike` interfaces |
| Policy | `@parley/policy` (`CallPolicy`/`CallEnvelope` schema, `composePolicy` guardrail composition, presets) | Nothing from `@parley/core` — deliberately decoupled; `CallEnvelope`'s `brief` shape is its own zod schema, not the `@parley/core` `Brief` type |
| Audio resampling | `@parley/audio` (μ-law ⟷ PCM; inbound 8k→16k linear resample, outbound single ÷3 averaging decimation 24k→8k) | Nothing (standalone-usable) |
| Telephony | `@parley/telephony-twilio` | `@parley/core`'s interfaces |
| Realtime | `@parley/realtime-gemini` | `@parley/core`'s interfaces, `@google/genai` |
| Daemon | `@parley/server` (plain `node:http` + `ws`, no web framework) | `@parley/core` + `@parley/policy` + the two provider packages |
| CLI | `@parley/cli` (`parley serve`, `parley call`, `parley harness …`, `parley doctor`; optional post-call command hook) | all of the above |
| Reliability | `@parley/harness` | `@parley/core`, `@parley/policy`, `@parley/realtime-gemini` |

`CallSession` (built in Milestone 2, unchanged in Milestone 3) depends only on the three injected
interfaces — `TelephonyProvider`, `RealtimeProvider`, `AudioCodec` — and exposes
`resolveSystemInstruction()`, `originate()`, and `attach(callId, socket)`. Milestone 3 is
additive: it implements the interfaces (`@parley/telephony-twilio`, already-existing
`@parley/realtime-gemini`) and wires a daemon (`@parley/server`) and a unified CLI
(`@parley/cli`) around them. **No changes were made to `@parley/core` in Milestone 3** — a change
there would have been a design smell to escalate, not something this milestone needed.

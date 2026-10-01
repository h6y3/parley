# Provider authoring guide

Parley's entire extension surface is two interfaces in `@parley/core`:
`TelephonyProvider` and `RealtimeProvider` (`packages/core/src/types.ts`). `CallSession` and the
prompt-assembly logic depend only on these two interfaces — never on Twilio or Gemini directly —
so a new carrier or a new realtime model is an additive package, not a change to `@parley/core`.
This guide walks through implementing each, using `@parley/telephony-twilio` and
`@parley/realtime-gemini` as the worked examples that already ship.

## `TelephonyProvider`

```typescript
export interface TelephonyProvider {
  readonly name: string;
  readonly mediaEncoding: AudioEncoding;
  originate(params: OriginateParams): Promise<OriginateResult>;
  buildAnswerResponse(params: AnswerResponseParams): AnswerResponse;
  verifyWebhookSignature(request: WebhookVerificationRequest): boolean;
  attachMediaStream(params: AttachMediaStreamParams): MediaStreamHandle;
  hangup(callId: string, reason?: string): Promise<void>;
}
```

### `mediaEncoding` — declare the carrier's audio

`mediaEncoding` is the encoding of the carrier's media stream in both directions (`mulaw@8000` for
Twilio). It is a property of the provider rather than of a media handle because it must be known
before any call exists: `CallSession` checks it against the realtime provider's `audio` and
refuses an unbridgeable pairing before a phone rings. A carrier that streams anything else needs a
conversion path in `@parley/audio` (`canConvert` reports which pairs exist).

### `originate` — place the call

Twilio's implementation (`TwilioTelephonyProvider.originate`,
`packages/telephony-twilio/src/twilio-telephony-provider.ts`) POSTs to the Calls REST resource
with `To`/`From`/`Url` (and optionally `StatusCallback`), using `fetch` and HTTP Basic auth built
from `accountSid`/`authToken` — no Twilio SDK dependency, just the REST API directly. It maps a
failed HTTP response to `{ providerCallId: "", status: "failed" }` rather than throwing, and
normalizes an unrecognized status string to `"queued"` so an unexpected value from the carrier
never crashes the caller. A new provider should follow the same shape: return a provider-native
call ID plus one of the four `OriginateResult.status` values, and prefer a mapped failure result
over throwing where the carrier reports failure through its own status field.

### `buildAnswerResponse` — tell the carrier where to stream audio

For Twilio this returns TwiML: `<Response><Connect><Stream url="wss://HOST/media/{CallSid}"/>
</Connect></Response>` (`buildStreamTwiml`, `packages/telephony-twilio/src/twiml.ts`). The
`mediaStreamUrl` is already per-call in `AnswerResponseParams` — the caller (`@parley/server`)
constructs it from the CallSid and its own host allowlist; the provider's job is only to render
that URL into whatever protocol-specific response its carrier expects, with attribute values
escaped for the response's content type (Twilio's TwiML is XML, so `escapeXmlAttr` guards
against a `mediaStreamUrl` value breaking the document).

### `verifyWebhookSignature` — fail closed, always

This is the one method with a hard contract, not just a suggested shape: **any doubt returns
`false`, never a best-effort accept.** `verifyTwilioSignature`
(`packages/telephony-twilio/src/signature.ts`) returns `false` outright on a missing auth token or
missing provided signature, computes the carrier's HMAC over `fullUrl` (which the _caller_ must
have already reconstructed from a host allowlist, never from a raw `Host` header — see
`docs/security-model.md`) plus the sorted, concatenated form parameters, and compares with
`crypto.timingSafeEqual` rather than `===` to avoid a timing side channel. A new provider
implementing a different carrier's signature scheme must preserve this contract: fail closed on
anything ambiguous, and use a constant-time comparison for the final check.

### `attachMediaStream` — parse the carrier's audio protocol

Twilio's Media Streams protocol is newline-delimited JSON text frames over a WebSocket:
`connected`, `start` (carries the `streamSid` every outbound frame needs), `media` (base64 μ-law
8kHz payload), `mark`, `stop`. `attachTwilioMediaStream`
(`packages/telephony-twilio/src/media-stream.ts`) parses inbound frames defensively — a malformed
frame is ignored, never thrown, since this data comes straight off the wire from a carrier — and
returns a `MediaStreamHandle` whose `sendOutboundAudio` guards against sending before `streamSid`
is known (drop-with-no-op, not a crash) and whose `clearOutboundBuffer` sends the carrier's
`clear` event, which is the telephony-layer half of barge-in (the application-layer half is
`@parley/audio`'s local buffer clear, driven by `RealtimeSessionCallbacks.onInterrupted`). A new
provider implements this against `AttachMediaStreamParams.socket: WebSocketLike` — Parley's own
minimal socket contract (`send`/`on`/`close`), not a `ws`-specific type, so the provider package
itself needs no `ws` dependency; the daemon (`@parley/server`) is what adapts a real `ws` socket
to `WebSocketLike` (`packages/server/src/ws-adapter.ts`).

### `hangup`

A thin REST wrapper in Twilio's case (a `Status: completed` update) — no special design
constraints beyond matching the interface's async signature. There is no `sendDtmf`: keypresses
are tones in the audio stream, generated by `AudioCodec.dtmfTones`.

## `RealtimeProvider`

```typescript
export interface RealtimeProvider {
  readonly name: string;
  readonly audio: RealtimeAudioFormat; // { accepts: AudioEncoding[]; emits: AudioEncoding }
  readonly maxSessionSeconds?: number;
  readonly openingDelivery:
    OpeningDelivery | { twoParty: OpeningDelivery; meeting: OpeningDelivery }; // "turn" | "prompt"
  readonly continuesAfterToolResponse: boolean;
  connect(params: RealtimeConnectParams): Promise<RealtimeSession>;
}

export interface RealtimeSession {
  sendOpeningTrigger(text: string): void;
  sendAudio(frame: AudioFrame): void;
  notifyActivityEnd(): void;
  close(): Promise<void>;
}
```

### `audio` and `maxSessionSeconds` — declare what the vendor speaks and how long it lasts

`audio.accepts` lists the encodings `sendAudio` takes, most preferred first; `audio.emits` is the
one encoding `onAudio` frames arrive in. `CallSession` bridges each direction to the carrier from
this declaration, converting only when the carrier's encoding is not already accepted, so a
provider that speaks the carrier's own encoding (Deepgram, `mulaw@8000`) costs no conversion.
Declare exactly what the vendor wire does; `sendAudio` should still reject a frame outside
`accepts` rather than guess. `GeminiRealtimeProvider` declares `pcm@16000` in and `pcm@24000` out.

`maxSessionSeconds` is the longest single session the vendor permits, if it bounds one (Deepgram:
7200). Declare it whenever a limit exists: `@parley/server` refuses, before dialling, a call whose
possible duration exceeds it, because a vendor ending the session mid-call leaves a live phone
line with nothing on our end of it. A provider that declares none is never refused on duration.

`RealtimeSessionCallbacks` also has optional `onTurnComplete` (call it when the model finishes a
turn, so a goodbye can be drained rather than cut off) and `onDiagnostic` (transport facts for the
operator's log, never call content).

### `openingDelivery` — declare how the vendor takes the call's opening

Parley opens every call with a fixed instruction for the seconds before anything has been heard
(`OPENING_TRIGGER`, or `MEETING_OPENING_TRIGGER` on a meeting). `openingDelivery` says where that
text goes, and it is required: `CallSession`, and the harness runners, pass it to `planOpening`
(`@parley/core`), which is the only place the opening is decided.

- **`"turn"`** — the trigger is sent after connect through `sendOpeningTrigger`. Declare this when
  the vendor has a text input its model reads as an input to the session, not as the far end
  speaking. `GeminiRealtimeProvider` uses it for meetings; the trigger goes as realtime text input.
- **`"prompt"`** — the trigger is appended to the one-time `systemInstruction`, and on a
  two-party call `sendOpeningTrigger` is never called: the callee's own "hello" opens the call. On
  a meeting it is called once, with `MEETING_CONNECTED_CUE`, a single short line. Declare this
  when the vendor's only post-connect text input is a user turn. Deepgram's is
  `InjectUserMessage`, and sent the long trigger that way its model heard it as the callee: in
  billed text-mode runs one model hung up during the ring, and another said "I'm listening and
  waiting for the other end to speak" aloud on every run. The Deepgram provider declares
  `"prompt"`, and its `sendOpeningTrigger` refuses anything longer than twice the cue or containing
  a newline.
- **`{ twoParty, meeting }`** (`OpeningDeliveryByShape`) — one of the two values per call shape;
  `planOpening` reads `meeting` on a meeting and `twoParty` otherwise, and plans each exactly as
  the plain value. `GeminiRealtimeProvider` declares `{ twoParty: "prompt", meeting: "turn" }`. A
  trigger sent as its own turn at connect is a turn the model answers, and with line hiss or
  silence before the callee's "hello" Gemini answered it into the noise (offline, 3 s of hiss
  before the hello: speech before the callee in 9/18 runs as a turn, 0/72 in the prompt). With the
  opening in the prompt its first input is the far end's own audio — a person, a voicemail
  greeting or an IVR menu — and a silent line gives it nothing to answer. Its meetings keep the
  trigger as a turn, the only way they have run.

Either way the text is a Parley constant, never caller content, so the system instruction is
still built once, before connect, and never changed.

### `continuesAfterToolResponse` — declare whether the model speaks after a tool answer

Both shipped vendors send the tool call first and speak the words that go with it afterwards, in a
turn that starts only once the answer is sent: the goodbye after `end_call`, the acknowledgment
after `begin_notetaking`. On Deepgram's wire a goodbye began about 190 ms after the
`FunctionCallResponse` and ran 6.7 s. Gemini behaves the same way because every function is
declared `BLOCKING`: the model continues its turn after the response and ends it with
`turnComplete`.

Declare `true` for such a vendor. `CallSession` then treats every answered tool call as opening a
model turn, and the hangup and consent handoff wait for that turn to end before draining. The wait
is capped at four seconds without model audio, and each audio frame resets that timer. It is also
capped at 15 seconds overall. Declare `false` only for a vendor known to say nothing after a tool
answer: the hangup then drains at once, and a goodbye that arrives later is cut off. The field is
required, so every provider has to choose one.

### The deliberate absence — no systemInstruction update, no arbitrary-turn escape hatch

Read the shape of `RealtimeSession` closely: there is **no method to update `systemInstruction`
after `connect()`**, and **no general-purpose "send an arbitrary turn" method**. The only two ways
to put words in front of the model, ever, are `connect()`'s one-time `systemInstruction` parameter
and `sendOpeningTrigger()`'s one-shot short line (which a `"prompt"` provider is only ever sent on
a meeting). This is not an oversight to work around in a new
provider implementation — it is the interface-level enforcement of the correctness guarantee in
`docs/prompt-guide.md`. A new `RealtimeProvider` implementation must not expose any additional
method that would let a caller push a second privileged message mid-session, even if the
underlying vendor SDK offers one (see below).

`GeminiRealtimeProvider` (`packages/realtime-gemini/src/gemini-realtime-provider.ts`) is a
concrete illustration of holding this line under pressure: the underlying `@google/genai` SDK's
live session _does_ expose a `sendClientContent` method capable of sending an arbitrary turn, and
Gemini's own docs describe it as a way to seed initial history. `GeminiRealtimeProvider` never
calls it and never exposes a path to it through `RealtimeSession` — the returned session object
only implements `sendOpeningTrigger`/`sendAudio`/`notifyActivityEnd`/`close`. A team implementing
a provider over an SDK that offers a similar escape hatch should make the same choice: use the
underlying capability only for what `RealtimeConnectParams`/`RealtimeSession` expose, never wrap
and re-expose the vendor's broader surface.

### `connect` — session setup is where persona and config live, once

`GeminiRealtimeProvider.connect` builds the vendor SDK's session config from
`RealtimeConnectParams` — `systemInstruction` passed straight through as the vendor's own
system-instruction field, `responseModalities: [AUDIO]`, `outputAudioTranscription` unless
explicitly disabled, `turnCoverage: TURN_INCLUDES_ONLY_ACTIVITY`, sliding-window
`contextWindowCompression` unless disabled, and `automaticActivityDetection.silenceDurationMs`
defaulted to 700ms if the caller doesn't override it — then calls the SDK's own `connect`, and
translates every callback the SDK reports (audio chunks, interruption, transcript text, errors,
close) into the four `RealtimeSessionCallbacks` Parley defines. A new provider's `connect` should
follow the same pattern: accept `RealtimeConnectParams` as given, translate the vendor's own
config surface underneath it, and normalize the vendor's event/callback shape into exactly
`onAudio`/`onInterrupted`/`onTranscript`/`onError`/`onClose` — no additional callback types, so
`CallSession` never has to special-case a particular provider.

### `sendAudio` / `notifyActivityEnd`

`sendAudio` streams one `AudioFrame` of caller audio into the model per call; Gemini's
implementation sends it via `send_realtime_input`, matching the `RealtimeConnectParams` design
note that `send_realtime_input` (not `send_client_content`) is the channel for moving a live
conversation forward. `notifyActivityEnd` is a no-op under automatic VAD (Parley's V1 default) and
only meaningful under manual turn detection — a new provider should implement it as a genuine
no-op rather than a fake signal if its underlying transport also defaults to automatic activity
detection.

## Registering a new provider

Neither interface requires touching `@parley/core`. A new package implements one interface (or
both, for a fully new carrier+model pairing), is instantiated by the consumer (or wired into
`@parley/cli`'s `serve()`/`@parley/server`'s `ParleyServerConfig` for daemon use), and is passed
into `CallSession`/`createParleyServer` exactly where `TwilioTelephonyProvider` and
`GeminiRealtimeProvider` are today. If implementing a new provider ever seems to require a change
to `@parley/core`'s interfaces or to `CallSession`'s orchestration, treat that as a signal the
interface itself needs revisiting — not something to work around inside the new provider package.

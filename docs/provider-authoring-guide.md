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
  originate(params: OriginateParams): Promise<OriginateResult>;
  buildAnswerResponse(params: AnswerResponseParams): AnswerResponse;
  verifyWebhookSignature(request: WebhookVerificationRequest): boolean;
  attachMediaStream(params: AttachMediaStreamParams): MediaStreamHandle;
  sendDtmf(callId: string, digits: string): Promise<void>;
  hangup(callId: string, reason?: string): Promise<void>;
}
```

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
missing provided signature, computes the carrier's HMAC over `fullUrl` (which the *caller* must
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

### `sendDtmf` / `hangup`

Thin REST wrappers in Twilio's case (`Play digits=` TwiML for DTMF; a `Status: completed` update
for hangup) — no special design constraints beyond matching the interface's async signature.

## `RealtimeProvider`

```typescript
export interface RealtimeProvider {
  readonly name: string;
  connect(params: RealtimeConnectParams): Promise<RealtimeSession>;
}

export interface RealtimeSession {
  sendOpeningTrigger(text: string): void;
  sendAudio(frame: AudioFrame): void;
  notifyActivityEnd(): void;
  close(): Promise<void>;
}
```

### The deliberate absence — no systemInstruction update, no arbitrary-turn escape hatch

Read the shape of `RealtimeSession` closely: there is **no method to update `systemInstruction`
after `connect()`**, and **no general-purpose "send an arbitrary turn" method**. The only two ways
to put words in front of the model, ever, are `connect()`'s one-time `systemInstruction` parameter
and `sendOpeningTrigger()`'s one-shot short line. This is not an oversight to work around in a new
provider implementation — it is the interface-level enforcement of the correctness guarantee in
`docs/prompt-guide.md`. A new `RealtimeProvider` implementation must not expose any additional
method that would let a caller push a second privileged message mid-session, even if the
underlying vendor SDK offers one (see below).

`GeminiRealtimeProvider` (`packages/realtime-gemini/src/gemini-realtime-provider.ts`) is a
concrete illustration of holding this line under pressure: the underlying `@google/genai` SDK's
live session *does* expose a `sendClientContent` method capable of sending an arbitrary turn, and
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

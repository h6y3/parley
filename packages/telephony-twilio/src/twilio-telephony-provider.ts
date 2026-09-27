import {
  SEND_DIGITS_MAX_LENGTH,
  SEND_DIGITS_PATTERN,
  type AnswerResponse,
  type AnswerResponseParams,
  type AttachMediaStreamParams,
  type MediaStreamHandle,
  type OriginateParams,
  type OriginateResult,
  type TelephonyProvider,
  type WebhookVerificationRequest
} from "@parley/core";
import { attachTwilioMediaStream } from "./media-stream.js";
import { verifyTwilioSignature } from "./signature.js";
import { buildStreamTwiml } from "./twiml.js";

/** Validate `sendDigits` BEFORE it ever reaches `fetch`, so one bad character
 * deep in a bridge's entry sequence fails loudly and locally rather than
 * failing the whole origination against Twilio's API (or, worse, silently
 * dropping the parameter and dialling a call nothing will ever enter the
 * bridge for).
 *
 * The thrown message deliberately never echoes `sendDigits` itself: the value
 * typically carries a bridge passcode (see `OriginateParams.sendDigits`), and
 * an error message is a surface nothing in this codebase redacts on its way
 * to a log — see the `redactSecrets` note on that field. */
function validateSendDigits(sendDigits: string): void {
  if (sendDigits.length < 1 || sendDigits.length > SEND_DIGITS_MAX_LENGTH) {
    throw new Error(
      `sendDigits must be 1-${SEND_DIGITS_MAX_LENGTH} characters (received length ` +
        `${sendDigits.length})`
    );
  }
  if (!SEND_DIGITS_PATTERN.test(sendDigits)) {
    throw new Error(
      "sendDigits contains a character outside Twilio's SendDigits alphabet (0-9, *, #, w, W)"
    );
  }
}

export interface TwilioTelephonyProviderOptions {
  accountSid: string;
  authToken: string;
  /** Override for tests; defaults to Twilio's production REST base. */
  apiBase?: string;
  /** Override for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_BASE = "https://api.twilio.com";
const KNOWN_STATUSES: OriginateResult["status"][] = ["queued", "ringing", "in-progress", "failed"];

/** The V1 TelephonyProvider over Twilio's REST API + Media Streams protocol
 * (design spec §7.1). Uses global fetch for REST (no twilio SDK) and node:crypto
 * for signatures (via verifyTwilioSignature); operates on WebSocketLike for
 * media (no ws dependency). */
export class TwilioTelephonyProvider implements TelephonyProvider {
  readonly name = "twilio";
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TwilioTelephonyProviderOptions) {
    this.accountSid = options.accountSid;
    this.authToken = options.authToken;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private callsUrl(suffix = ""): string {
    return `${this.apiBase}/2010-04-01/Accounts/${this.accountSid}/Calls${suffix}`;
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
  }

  async originate(params: OriginateParams): Promise<OriginateResult> {
    const body = new URLSearchParams({
      To: params.to,
      From: params.from,
      Url: params.answerWebhookUrl
    });
    if (params.statusCallbackUrl) {
      body.set("StatusCallback", params.statusCallbackUrl);
      // Twilio takes these space-separated in one field, not as repeated keys.
      body.set("StatusCallbackEvent", "initiated ringing answered completed");
    }
    if (params.machineDetection) body.set("MachineDetection", params.machineDetection);
    if (params.sendDigits !== undefined) {
      validateSendDigits(params.sendDigits);
      body.set("SendDigits", params.sendDigits);
    }
    const res = await this.fetchImpl(this.callsUrl(".json"), {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    if (!res.ok) return { providerCallId: "", status: "failed" };
    const json = (await res.json()) as { sid: string; status: string };
    const status = KNOWN_STATUSES.includes(json.status as OriginateResult["status"])
      ? (json.status as OriginateResult["status"])
      : "queued";
    return { providerCallId: json.sid, status };
  }

  buildAnswerResponse(params: AnswerResponseParams): AnswerResponse {
    return { contentType: "text/xml", body: buildStreamTwiml(params.mediaStreamUrl) };
  }

  verifyWebhookSignature(request: WebhookVerificationRequest): boolean {
    return verifyTwilioSignature(
      this.authToken,
      request.fullUrl,
      request.rawBody,
      request.headers["x-twilio-signature"]
    );
  }

  attachMediaStream(params: AttachMediaStreamParams): MediaStreamHandle {
    return attachTwilioMediaStream(params);
  }

  /* sendDtmf is gone, deliberately. It posted
       <Response><Play digits="N"/></Response>
     to POST /Calls/{sid}.json, and posting TwiML REDIRECTS a live call: it tore
     down the <Connect><Stream> carrying the conversation, played the tone to
     nobody, hit the end of the new document and hung up. Measured on the first
     live call that ever pressed a key. Keypresses are audio now — see
     AudioCodec.dtmfTones.

     `sendDigits` above is NOT a reversal of this. It is a parameter of the
     ORIGINATION request (`originate`, above) — set before the call is even
     dialled, let alone answered — not a REST action posted against a call
     already carrying a live <Connect><Stream>. There is no TwiML document to
     redirect and no media stream to tear down; Twilio plays the tones itself,
     out-of-band, once it answers. The failure mode this note describes cannot
     reach it. */

  async hangup(callId: string): Promise<void> {
    await this.fetchImpl(this.callsUrl(`/${callId}.json`), {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ Status: "completed" }).toString()
    });
  }
}

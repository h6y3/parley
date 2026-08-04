import type {
  AnswerResponse,
  AnswerResponseParams,
  AttachMediaStreamParams,
  MediaStreamHandle,
  OriginateParams,
  OriginateResult,
  TelephonyProvider,
  WebhookVerificationRequest
} from "@parley/core";
import { attachTwilioMediaStream } from "./media-stream.js";
import { verifyTwilioSignature } from "./signature.js";
import { buildStreamTwiml } from "./twiml.js";

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
    const body = new URLSearchParams({ To: params.to, From: params.from, Url: params.answerWebhookUrl });
    if (params.statusCallbackUrl) body.set("StatusCallback", params.statusCallbackUrl);
    const res = await this.fetchImpl(this.callsUrl(".json"), {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
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

  async sendDtmf(callId: string, digits: string): Promise<void> {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${digits}"/></Response>`;
    await this.fetchImpl(this.callsUrl(`/${callId}.json`), {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Twiml: twiml }).toString()
    });
  }

  async hangup(callId: string): Promise<void> {
    await this.fetchImpl(this.callsUrl(`/${callId}.json`), {
      method: "POST",
      headers: { Authorization: this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Status: "completed" }).toString()
    });
  }
}

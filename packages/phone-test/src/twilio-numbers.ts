export interface OwnedNumber {
  sid: string;
  phoneNumber: string;
}

export interface TwilioNumbersClient {
  accountType(): Promise<"Trial" | "Full">;
  buyLocal(opts: {
    voiceUrl: string;
    statusCallback?: string;
    friendlyName: string;
  }): Promise<OwnedNumber>;
  findByFriendlyName(name: string): Promise<OwnedNumber[]>;
  release(sid: string): Promise<"released" | "already-gone">;
}

export interface TwilioNumbersClientOptions {
  accountSid: string;
  authToken: string;
  /** Override for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Override for tests; defaults to Twilio's production REST base. */
  apiBase?: string;
  /** Per-request deadline, covering the response body. Defaults to 15000. */
  timeoutMs?: number;
}

const DEFAULT_API_BASE = "https://api.twilio.com";
const DEFAULT_TIMEOUT_MS = 15_000;

interface NumbersPage {
  incoming_phone_numbers?: { sid: string; phone_number: string }[];
  next_page_uri?: string | null;
}

/** Minimal Twilio REST client for the test harness's number lifecycle.
 *
 * Failure messages carry the HTTP status and the endpoint path only. Never the
 * Authorization header, never the response body: Twilio bodies can echo account
 * data, and an error message is a surface nothing downstream redacts. */
export function createTwilioNumbersClient(opts: TwilioNumbersClientOptions): TwilioNumbersClient {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const account = `/2010-04-01/Accounts/${opts.accountSid}`;
  const auth = "Basic " + Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64");

  const bare = (pathAndQuery: string): string => pathAndQuery.split("?")[0] ?? "";

  const fail = (status: number, pathAndQuery: string): Error =>
    new Error(`Twilio request failed: ${status} ${bare(pathAndQuery)}`);

  /** A timeout surfaces as a path-only message; the abort reason is dropped
   * rather than wrapped, so nothing request-shaped rides along as a cause. */
  async function guard<T>(pathAndQuery: string, signal: AbortSignal, run: () => Promise<T>) {
    try {
      return await run();
    } catch (err) {
      if (signal.aborted) throw new Error(`Twilio request timed out: ${bare(pathAndQuery)}`);
      throw err;
    }
  }

  async function send(method: string, pathAndQuery: string, form?: URLSearchParams) {
    const headers: Record<string, string> = { Authorization: auth };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await guard(pathAndQuery, signal, () =>
      fetchImpl(`${apiBase}${pathAndQuery}`, {
        method,
        headers,
        signal,
        ...(form ? { body: form.toString() } : {})
      })
    );
    return { res, signal };
  }

  async function json<T>(method: string, pathAndQuery: string, form?: URLSearchParams): Promise<T> {
    const { res, signal } = await send(method, pathAndQuery, form);
    if (!res.ok) throw fail(res.status, pathAndQuery);
    return guard(pathAndQuery, signal, async () => (await res.json()) as T);
  }

  return {
    async accountType() {
      const body = await json<{ type?: string }>("GET", `${account}.json`);
      if (body.type !== "Trial" && body.type !== "Full") {
        throw new Error(`Twilio account type unrecognised at ${account}.json`);
      }
      return body.type;
    },

    async buyLocal({ voiceUrl, statusCallback, friendlyName }) {
      const search = await json<{ available_phone_numbers?: { phone_number: string }[] }>(
        "GET",
        `${account}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=1`
      );
      const candidate = search.available_phone_numbers?.[0]?.phone_number;
      if (!candidate) throw new Error("no available numbers");
      const form = new URLSearchParams({
        PhoneNumber: candidate,
        VoiceUrl: voiceUrl,
        VoiceMethod: "POST",
        FriendlyName: friendlyName
      });
      if (statusCallback) {
        form.set("StatusCallback", statusCallback);
        form.set("StatusCallbackMethod", "POST");
      }
      const bought = await json<{ sid: string; phone_number: string }>(
        "POST",
        `${account}/IncomingPhoneNumbers.json`,
        form
      );
      return { sid: bought.sid, phoneNumber: bought.phone_number };
    },

    async findByFriendlyName(name) {
      const out: OwnedNumber[] = [];
      let next: string | null =
        `${account}/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(name)}`;
      while (next) {
        const page: NumbersPage = await json<NumbersPage>("GET", next);
        for (const n of page.incoming_phone_numbers ?? []) {
          out.push({ sid: n.sid, phoneNumber: n.phone_number });
        }
        next = page.next_page_uri ?? null;
      }
      return out;
    },

    async release(sid) {
      const path = `${account}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`;
      const { res } = await send("DELETE", path);
      if (res.status === 204) return "released";
      if (res.status === 404) return "already-gone";
      throw fail(res.status, path);
    }
  };
}

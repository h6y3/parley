import { describe, expect, it } from "vitest";
import { createTwilioNumbersClient } from "../src/twilio-numbers.js";

interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
const SID = "ACtest0000000000000000000000000000";
const TOKEN = "super-secret-token";
const BASE = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;

function fake(responses: Array<{ status: number; body?: unknown }>) {
  const reqs: Req[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    reqs.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined
    });
    const r = responses.shift() ?? { status: 500 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status
    });
  }) as unknown as typeof fetch;
  return {
    reqs,
    client: createTwilioNumbersClient({ accountSid: SID, authToken: TOKEN, fetch: f })
  };
}

describe("twilio numbers client", () => {
  it("buys a local number with exact requests", async () => {
    const { reqs, client } = fake([
      { status: 200, body: { available_phone_numbers: [{ phone_number: "+15555550101" }] } },
      { status: 201, body: { sid: "PN1", phone_number: "+15555550101" } }
    ]);
    const out = await client.buyLocal({
      voiceUrl: "https://voice.example.com/sim/twilio/answer",
      statusCallback: "https://voice.example.com/sim/status",
      friendlyName: "parley-test-1"
    });
    expect(out).toEqual({ sid: "PN1", phoneNumber: "+15555550101" });
    expect(reqs[0]).toMatchObject({
      url: `${BASE}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=1`,
      method: "GET"
    });
    expect(reqs[1].url).toBe(`${BASE}/IncomingPhoneNumbers.json`);
    expect(reqs[1].method).toBe("POST");
    const form = new URLSearchParams(reqs[1].body);
    expect(Object.fromEntries(form)).toEqual({
      PhoneNumber: "+15555550101",
      VoiceUrl: "https://voice.example.com/sim/twilio/answer",
      VoiceMethod: "POST",
      FriendlyName: "parley-test-1",
      StatusCallback: "https://voice.example.com/sim/status",
      StatusCallbackMethod: "POST"
    });
    const expected = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
    expect(reqs[0].headers.Authorization).toBe(expected);
    expect(reqs[1].headers.Authorization).toBe(expected);
  });

  it("omits StatusCallback when not given", async () => {
    const { reqs, client } = fake([
      { status: 200, body: { available_phone_numbers: [{ phone_number: "+15555550101" }] } },
      { status: 201, body: { sid: "PN1", phone_number: "+15555550101" } }
    ]);
    await client.buyLocal({ voiceUrl: "https://voice.example.com/a", friendlyName: "n" });
    expect(new URLSearchParams(reqs[1].body).has("StatusCallback")).toBe(false);
  });

  it("throws on an empty search", async () => {
    const { client } = fake([{ status: 200, body: { available_phone_numbers: [] } }]);
    await expect(client.buyLocal({ voiceUrl: "u", friendlyName: "n" })).rejects.toThrow(
      "no available numbers"
    );
  });

  it("release: 204 released, 404 already-gone, else throws", async () => {
    const a = fake([{ status: 204 }]);
    expect(await a.client.release("PN1")).toBe("released");
    expect(a.reqs[0]).toMatchObject({
      url: `${BASE}/IncomingPhoneNumbers/PN1.json`,
      method: "DELETE"
    });
    const b = fake([{ status: 404 }]);
    expect(await b.client.release("PN1")).toBe("already-gone");
    const c = fake([{ status: 500, body: { leak: TOKEN, email: "x@y.z" } }]);
    const err = (await c.client.release("PN1").catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      `Twilio request failed: 500 /2010-04-01/Accounts/${SID}/IncomingPhoneNumbers/PN1.json`
    );
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("x@y.z");
  });

  it("errors never contain the auth header", async () => {
    const { client } = fake([{ status: 401, body: { message: "bad" } }]);
    const err = (await client.accountType().catch((e: Error) => e)) as Error;
    const b64 = Buffer.from(`${SID}:${TOKEN}`).toString("base64");
    expect(err.message).toContain("401");
    expect(err.message).not.toContain(b64);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("bad");
  });

  it("accountType reads type", async () => {
    const t = fake([{ status: 200, body: { type: "Trial" } }]);
    expect(await t.client.accountType()).toBe("Trial");
    expect(t.reqs[0].url).toBe(`${BASE}.json`);
    const f = fake([{ status: 200, body: { type: "Full" } }]);
    expect(await f.client.accountType()).toBe("Full");
    const u = fake([{ status: 200, body: { type: "Weird" } }]);
    await expect(u.client.accountType()).rejects.toThrow();
  });

  it("findByFriendlyName paginates", async () => {
    const { reqs, client } = fake([
      {
        status: 200,
        body: {
          incoming_phone_numbers: [{ sid: "PN1", phone_number: "+15555550101" }],
          next_page_uri: `/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json?FriendlyName=a%20b&Page=1&PageSize=50`
        }
      },
      {
        status: 200,
        body: {
          incoming_phone_numbers: [{ sid: "PN2", phone_number: "+15555550102" }],
          next_page_uri: null
        }
      }
    ]);
    const out = await client.findByFriendlyName("a b");
    expect(out).toEqual([
      { sid: "PN1", phoneNumber: "+15555550101" },
      { sid: "PN2", phoneNumber: "+15555550102" }
    ]);
    expect(reqs[0].url).toBe(`${BASE}/IncomingPhoneNumbers.json?FriendlyName=a%20b`);
    expect(reqs[1].url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json?FriendlyName=a%20b&Page=1&PageSize=50`
    );
  });

  it("every request carries an abort signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(JSON.stringify({ type: "Full" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createTwilioNumbersClient({ accountSid: SID, authToken: TOKEN, fetch: f });
    await client.accountType();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("a hung request times out with a path-only message", async () => {
    const f = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const client = createTwilioNumbersClient({
      accountSid: SID,
      authToken: TOKEN,
      fetch: f,
      timeoutMs: 20
    });
    const err = (await client.release("PN1").catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      `Twilio request timed out: /2010-04-01/Accounts/${SID}/IncomingPhoneNumbers/PN1.json`
    );
    expect(err.message).not.toContain(TOKEN);
    const err2 = (await client.findByFriendlyName("x").catch((e: Error) => e)) as Error;
    expect(err2.message).toBe(
      `Twilio request timed out: /2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json`
    );
  });

  it("encodes the sid in the release path", async () => {
    const { reqs, client } = fake([{ status: 204 }]);
    await client.release("PN1/../x?y");
    expect(reqs[0].url).toBe(`${BASE}/IncomingPhoneNumbers/PN1%2F..%2Fx%3Fy.json`);
  });
});

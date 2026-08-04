import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTwilioSignature } from "../src/signature.js";

const TOKEN = "faketok";
const URL = "https://voice.example.com/twilio/answer";

/** Reference implementation of Twilio's algorithm, used to produce a valid
 * signature the code under test must accept: base64(HMAC-SHA1(token, url +
 * each POST param concatenated key+value in alphabetical key order)). */
function sign(token: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

describe("verifyTwilioSignature", () => {
  const params = { CallSid: "CA123", From: "+14155550001", To: "+14155550002" };
  const rawBody = new URLSearchParams(params).toString();

  it("accepts a correctly signed request", () => {
    const sig = sign(TOKEN, URL, params);
    expect(verifyTwilioSignature(TOKEN, URL, rawBody, sig)).toBe(true);
  });

  it("rejects a tampered body (fail closed)", () => {
    const sig = sign(TOKEN, URL, params);
    const tampered = new URLSearchParams({ ...params, To: "+19998887777" }).toString();
    expect(verifyTwilioSignature(TOKEN, URL, tampered, sig)).toBe(false);
  });

  it("rejects a wrong URL (SSRF-spoofed host)", () => {
    const sig = sign(TOKEN, "https://attacker.example.com/twilio/answer", params);
    expect(verifyTwilioSignature(TOKEN, URL, rawBody, sig)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyTwilioSignature(TOKEN, URL, rawBody, undefined)).toBe(false);
  });

  it("rejects an empty auth token", () => {
    const sig = sign(TOKEN, URL, params);
    expect(verifyTwilioSignature("", URL, rawBody, sig)).toBe(false);
  });

  it("rejects a malformed base64 signature without throwing", () => {
    expect(verifyTwilioSignature(TOKEN, URL, rawBody, "!!!not-base64!!!")).toBe(false);
  });
});

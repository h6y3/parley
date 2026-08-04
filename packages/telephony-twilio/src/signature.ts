import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify a Twilio webhook signature. Fails closed: a missing signature,
 * empty token, tampered body, or spoofed URL all return false (design spec
 * §8). `fullUrl` MUST be reconstructed by the caller from a configured host
 * allowlist — never from request Host/X-Forwarded-Host headers — so this
 * function is SSRF-safe by construction. */
export function verifyTwilioSignature(
  authToken: string,
  fullUrl: string,
  rawBody: string,
  providedSignature: string | undefined
): boolean {
  if (!authToken || !providedSignature) return false;

  const params = new URLSearchParams(rawBody);
  const sortedConcat = [...params.keys()]
    .sort()
    .map((key) => key + params.getAll(key).join(""))
    .join("");
  const data = fullUrl + sortedConcat;
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(providedSignature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

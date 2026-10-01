// `send[_-]?digits` is deliberately narrower than a bare `digits`: it matches
// `sendDigits` (OriginateParams / execution.dial — carrier-side DTMF that
// typically carries a bridge passcode) without over-matching `allowedDigits`
// (the permitted-keypad-character config for the model's in-band
// `press_digits` tool) or `digits` (that tool's own call argument) — neither
// of which is a secret.
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|send[_-]?digits)/i;
const REDACTED = "[redacted]";

/** Deep-walks an arbitrary value (object, array, or primitive) and replaces the
 * VALUE of any object key matching a known secret-shaped name with a fixed
 * placeholder, recursing into everything else. Applies to briefs, transcripts,
 * and errors before they are logged, on by default (design spec §8). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(val);
    }
    return result;
  }
  return value;
}

const CLOSE_REASON_MAX = 300;

/** Credentials that stand on their own, with no `key=` in front: a Google
 * API key, `sk-…` keys, GitHub tokens, and any long run of letters and digits
 * mixing both (a hex or base62 key). Hyphens are not part of the generic run,
 * so a UUID request id — useful, and not a credential — survives. */
const BARE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g
];

/** Makes a vendor's close reason safe to write into a call record: phone
 * numbers (`+`-prefixed, or any bare run of ten or more digits) masked with
 * `redactPhoneNumber`, credential-shaped `key=value` / `Bearer x` text and
 * bare keys and tokens replaced, whitespace flattened, and the whole capped.
 * The reason is the vendor's own words, not ours, so nothing about its content
 * is trusted. Credentials go first, so a digit run inside a key is removed
 * with the key rather than half-masked. */
export function redactCloseReason(reason: string): string {
  let cleaned = reason;
  for (const pattern of BARE_CREDENTIAL_PATTERNS) cleaned = cleaned.replace(pattern, REDACTED);
  cleaned = cleaned
    .replace(/\+\d[\d\s().-]{5,}\d/g, (m) => redactPhoneNumber(m.replace(/[\s().-]/g, "")))
    // Not inside a hyphenated id: a UUID's last group is 12 digits.
    .replace(/(?<![\w-])\d{10,}(?![\w-])/g, (m) => redactPhoneNumber(m))
    .replace(
      /(api[_-]?key|token|secret|password|authorization)(\s*[=:]\s*)(Bearer\s+)?\S+/gi,
      (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > CLOSE_REASON_MAX ? cleaned.slice(0, CLOSE_REASON_MAX) : cleaned;
}

/** Masks all but the last 4 digits of an E.164 phone number, preserving a
 * leading "+" if present. A short string (<=5 chars) is masked entirely rather
 * than risk revealing all of it. */
export function redactPhoneNumber(e164: string): string {
  if (e164.length <= 5) return "*".repeat(e164.length);
  const last4 = e164.slice(-4);
  const prefix = e164.startsWith("+") ? "+" : "";
  const maskedLength = e164.length - last4.length - prefix.length;
  return `${prefix}${"*".repeat(maskedLength)}${last4}`;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization)/i;
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

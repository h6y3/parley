export interface NumberAllowlist {
  permits(e164: string): boolean;
}

export interface HostAllowlist {
  permits(host: string): boolean;
}

/** Strip formatting down to a bare +digits E.164-ish string, assuming US
 * numbering for a 10 or 11-digit number with no leading "+". The sole
 * consumer is `createNumberAllowlist` below, so this stays private here
 * rather than living in @parley/core. */
function normalizeE164(raw: string): string {
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits && !digits.startsWith("+")) {
    if (digits.length === 10) {
      digits = `+1${digits}`;
    } else if (digits.length === 11 && digits.startsWith("1")) {
      digits = `+${digits}`;
    }
  }
  return digits;
}

/** Callable-number allowlist (design spec §8). An empty list denies everything
 * — fail closed. Numbers are normalized before comparison so formatting differs
 * harmlessly. */
export function createNumberAllowlist(list: readonly string[]): NumberAllowlist {
  const set = new Set(list.map((n) => normalizeE164(n)));
  return { permits: (e164) => set.has(normalizeE164(e164)) };
}

/** Webhook-host allowlist (design spec §8, SSRF-safe). Only hosts on this list
 * are ever trusted when reconstructing a signed URL. */
export function createHostAllowlist(list: readonly string[]): HostAllowlist {
  const set = new Set(list.map((h) => h.toLowerCase()));
  return { permits: (host) => set.has(host.toLowerCase()) };
}

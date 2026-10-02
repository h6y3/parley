import { readFileSync } from "node:fs";

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

export interface NumberAllowlistOptions {
  /** A file of extra numbers, re-read on every `permits` call so an operator
   * can add or remove one without restarting the daemon. One E.164 number per
   * line; `#` starts a comment; blank and unparseable lines are ignored. */
  file?: string;
  /** Injected for tests; defaults to a UTF-8 `readFileSync`. */
  readFile?: (path: string) => string;
}

function parseNumberLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const bare = line.split("#")[0]?.trim() ?? "";
    if (/^\+?[\d\s().-]+$/.test(bare)) out.push(normalizeE164(bare));
  }
  return out;
}

/** Callable-number allowlist (design spec §8). An empty list denies everything
 * — fail closed. Numbers are normalized before comparison so formatting differs
 * harmlessly. With `opts.file`, numbers in that file are permitted too; it is
 * read on every call, and a missing or unreadable file adds no numbers (one
 * warning per distinct error, never a throw). This list is a guard against
 * typos, not access control: `PARLEY_CALL_TOKEN` is the control on POST /call. */
export function createNumberAllowlist(
  list: readonly string[],
  opts: NumberAllowlistOptions = {}
): NumberAllowlist {
  const set = new Set(list.map((n) => normalizeE164(n)));
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const warned = new Set<string>();
  return {
    permits: (e164) => {
      const n = normalizeE164(e164);
      if (!n) return false;
      if (set.has(n)) return true;
      if (!opts.file) return false;
      try {
        return parseNumberLines(read(opts.file)).includes(n);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!warned.has(msg)) {
          warned.add(msg);
          console.warn(`parley: callable-numbers file ${opts.file} unreadable: ${msg}`);
        }
        return false;
      }
    }
  };
}

/** Webhook-host allowlist (design spec §8, SSRF-safe). Only hosts on this list
 * are ever trusted when reconstructing a signed URL. */
export function createHostAllowlist(list: readonly string[]): HostAllowlist {
  const set = new Set(list.map((h) => h.toLowerCase()));
  return { permits: (host) => set.has(host.toLowerCase()) };
}

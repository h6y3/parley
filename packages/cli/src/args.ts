import type { RealtimeProviderKind } from "@parley/server";

export type { RealtimeProviderKind };

export interface ParleyArgs {
  command: "serve" | "call" | "harness" | "doctor" | "meeting" | "help";
  to?: string;
  briefPath?: string;
  /** Only meaningful for `serve`. The daemon's default realtime provider.
   * Defaults to "gemini"; that default must never change silently. Both
   * providers are built whenever their key is set — this only chooses which
   * one a call uses when nothing else does. */
  realtimeProvider?: RealtimeProviderKind;
  rest: string[];
}

function flag(rest: readonly string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
}

function parseRealtimeProvider(rest: readonly string[]): RealtimeProviderKind {
  const raw = flag(rest, "--realtime-provider");
  if (raw === undefined) return "gemini";
  if (raw === "gemini" || raw === "deepgram") return raw;
  // Refuse silently normalising a typo to the default — that would hide a
  // mistake as ordinary behavior instead of surfacing it.
  throw new Error(`--realtime-provider must be "gemini" or "deepgram", got "${raw}"`);
}

export function parseParleyArgs(argv: readonly string[]): ParleyArgs {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return { command: "serve", realtimeProvider: parseRealtimeProvider(rest), rest };
    case "call":
      return { command: "call", to: flag(rest, "--to"), briefPath: flag(rest, "--brief"), rest };
    case "harness":
      return { command: "harness", rest };
    // Captured verbatim and handed to @parley/meeting-browser, the same way
    // `harness` is handed to @parley/harness: the flags a meeting join takes
    // belong to the transport that reads them, and restating them here would
    // give the usage text two places to drift apart.
    case "meeting":
      return { command: "meeting", rest };
    case "doctor":
      return { command: "doctor", rest };
    default:
      return { command: "help", rest };
  }
}

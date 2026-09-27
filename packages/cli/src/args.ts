export type RealtimeProviderKind = "gemini" | "deepgram";

export interface ParleyArgs {
  command: "serve" | "call" | "harness" | "doctor" | "meeting" | "help";
  to?: string;
  briefPath?: string;
  /** Only meaningful for `serve`. Defaults to "gemini" — Deepgram Voice Agent
   * (@parley/realtime-deepgram) is a spike behind this flag, and the default
   * must never change silently: a spike that silently becomes production is
   * not a spike. See docs/decisions/2026-08-19-voice-agent-spike.md. */
  realtimeProvider?: RealtimeProviderKind;
  rest: string[];
}

function flag(rest: readonly string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
}

/** Why `deepgram` is refused rather than served.
 *
 * `RealtimeProvider` has no encoding negotiation: `CallSession`'s realtime sink
 * sends `codec.decodeInbound(frame)`, which is always `pcm@16000` (the Gemini
 * input rate), and `DeepgramRealtimeProvider.sendAudio` throws on anything that
 * is not `mulaw@8000`. Every inbound frame would throw inside the sink fan-out,
 * be caught, and log a diagnostic — fifty a second, for the length of the call,
 * while the agent heard nothing. Outbound is the mirror image: Deepgram emits
 * `mulaw@8000` and `encodeOutbound` treats its input as `pcm@24000`, so the
 * callee hears noise.
 *
 * A flag that produces a silent, log-flooding call is worse than no flag, and a
 * spike is exactly where that is cheapest to say out loud. The provider package
 * and its invariant suite stay; what is gated is putting a live call through
 * it. See docs/decisions/2026-08-19-voice-agent-spike.md. */
const DEEPGRAM_REALTIME_UNAVAILABLE =
  "--realtime-provider deepgram is not usable on a call: RealtimeProvider has no encoding " +
  "negotiation, so every inbound frame reaches the provider as pcm@16000 and is rejected " +
  "(the agent hears silence), and its mulaw@8000 output is encoded as if it were pcm@24000 " +
  "(the callee hears noise). Use --realtime-provider gemini. See " +
  "docs/decisions/2026-08-19-voice-agent-spike.md.";

function parseRealtimeProvider(rest: readonly string[]): RealtimeProviderKind {
  const raw = flag(rest, "--realtime-provider");
  if (raw === undefined) return "gemini";
  if (raw === "deepgram") throw new Error(DEEPGRAM_REALTIME_UNAVAILABLE);
  if (raw === "gemini") return raw;
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

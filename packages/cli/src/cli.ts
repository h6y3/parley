#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { convert, createAudioCodec } from "@parley/audio";
import type { RealtimeProvider } from "@parley/core";
import { runHarnessCli } from "@parley/harness";
import {
  createDeepgramRealtimeProvider,
  DEFAULT_DEEPGRAM_LLM_MODEL
} from "@parley/realtime-deepgram";
import { DEFAULT_GEMINI_MODEL, GeminiRealtimeProvider } from "@parley/realtime-gemini";
import {
  describeMeetingResult,
  isOperatorFacingError,
  meetingExitCode,
  runMeetingJoin,
  type MeetingJoinDeps
} from "@parley/meeting-browser";
import { createHostAllowlist, createNumberAllowlist, createParleyServer } from "@parley/server";
import { TwilioTelephonyProvider } from "@parley/telephony-twilio";
import { createDeepgramTranscriptionProvider } from "@parley/transcription-deepgram";
import { dirname, join } from "node:path";
import { parseParleyArgs, type RealtimeProviderKind } from "./args.js";
import { parseCallableNumbers, runCall, runCompletedCallPostCall, runDoctor } from "./commands.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** Build the realtime provider `serve` runs with, and the model string that
 * travels alongside it. Kept as its own function so the choice is made in
 * exactly one place: `--realtime-provider` defaults to "gemini"
 * (packages/cli/src/args.ts), and DEEPGRAM_API_KEY is only demanded when a
 * caller actually asked for the spike provider — requiring it unconditionally
 * would break every existing Gemini-only deployment the moment this package
 * was added. See docs/decisions/2026-08-19-voice-agent-spike.md.
 *
 * The `deepgram` branch is currently UNREACHABLE from the CLI: `parseParleyArgs`
 * refuses the flag, because `RealtimeProvider` has no encoding negotiation and a
 * Deepgram-backed call is silent one way and noise the other (see the reason
 * beside `DEEPGRAM_REALTIME_UNAVAILABLE` in args.ts). It is kept rather than
 * deleted because the wiring is correct and only the encoding contract is
 * missing — deleting it would make re-enabling the spike a rewrite instead of
 * removing one guard. */
function buildRealtimeProvider(kind: RealtimeProviderKind): {
  realtime: RealtimeProvider;
  model: string;
} {
  if (kind === "deepgram") {
    return {
      realtime: createDeepgramRealtimeProvider({ apiKey: requireEnv("DEEPGRAM_API_KEY") }),
      model: DEFAULT_DEEPGRAM_LLM_MODEL
    };
  }
  return {
    realtime: new GeminiRealtimeProvider({ apiKey: requireEnv("GEMINI_API_KEY") }),
    model: DEFAULT_GEMINI_MODEL
  };
}

/** The listening plane a meeting needs — genuinely independent of
 * `buildRealtimeProvider` above (the speaking plane): a meeting under either
 * `--realtime-provider` still needs somewhere to send audio once consent is
 * granted. Optional, unlike `buildRealtimeProvider`'s DEEPGRAM_API_KEY read:
 * a deployment with no transcription plane configured must still be able to
 * place ordinary (non-meeting) calls, so this reads the env var directly
 * rather than through `requireEnv`, and returns undefined rather than
 * throwing when it is unset. `request-handler.ts`'s `handleCall` is what
 * then refuses a meeting envelope at POST /call — see its own doc on
 * `ServerDeps.transcription`.
 *
 * DEEPGRAM_API_KEY is the same variable `buildRealtimeProvider` reads for
 * `--realtime-provider deepgram` — one Deepgram account key serves both of
 * its products here (realtime voice and transcription), which is why this
 * function does not invent a second env var name. The key itself never
 * appears in argv, a log line, or an error message: it is read once here and
 * handed straight to `createDeepgramTranscriptionProvider`, which (per its
 * own implementation) sends it only in a websocket header, never a URL. */
function buildTranscription():
  | { provider: ReturnType<typeof createDeepgramTranscriptionProvider>; convert: typeof convert }
  | undefined {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return undefined;
  return { provider: createDeepgramTranscriptionProvider({ apiKey }), convert };
}

async function serve(realtimeProviderKind: RealtimeProviderKind): Promise<void> {
  const callRecordsPath = process.env.PARLEY_CALL_RECORDS_PATH;
  const postCallCommand = process.env.PARLEY_POST_CALL_COMMAND;
  const { realtime, model } = buildRealtimeProvider(realtimeProviderKind);
  const transcription = buildTranscription();
  const handle = createParleyServer({
    telephony: new TwilioTelephonyProvider({
      accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
      authToken: requireEnv("TWILIO_AUTH_TOKEN")
    }),
    realtime,
    codec: createAudioCodec(),
    from: requireEnv("TWILIO_FROM_NUMBER"),
    publicHost: requireEnv("PARLEY_PUBLIC_HOST"),
    model,
    numberAllowlist: createNumberAllowlist(
      parseCallableNumbers(process.env.PARLEY_CALLABLE_NUMBERS)
    ),
    hostAllowlist: createHostAllowlist([requireEnv("PARLEY_PUBLIC_HOST")]),
    ...(transcription ? { transcription } : {}),
    // requireEnv, not an optional read. A daemon that starts without this would
    // answer every /call with 503, which surfaces hours later as an outage
    // rather than now as a misconfiguration. Fail at boot, loudly.
    callToken: requireEnv("PARLEY_CALL_TOKEN"),
    // Meeting or not, consented or not — the ordering (write, then write,
    // then spawn) and the branching (meeting vs ordinary, completed vs no
    // consent) all live in `runCompletedCallPostCall`, kept out of this file
    // so it is unit-testable without a live daemon. Returning its promise
    // (rather than firing it and forgetting) lets `handleMediaConnection`
    // await it before the carrier hangup runs — see media-connection.ts.
    onCallCompleted: callRecordsPath
      ? (record) =>
          runCompletedCallPostCall(
            {
              record,
              // `<records dir>/meetings/<UTC date>/<callId>/transcript.jsonl`
              // — see `meetingTranscriptDir` for why the date partition is
              // load-bearing rather than tidy.
              meetingsDir: join(dirname(callRecordsPath), "meetings"),
              recordsPath: callRecordsPath,
              command: postCallCommand
            },
            {}
          )
      : undefined
  });
  const port = Number(process.env.PARLEY_PORT ?? "3334");
  // Loopback unless deliberately overridden. Until 2026-08-17 no host was
  // plumbed here at all, so the daemon bound every interface and there was no
  // configuration that could have stopped it.
  const bindHost = process.env.PARLEY_BIND_HOST ?? "127.0.0.1";
  await handle.listen(port, bindHost);
  console.log(`parley daemon listening on ${bindHost}:${port}`);
}

/** The vendor edges `main` itself binds, injectable for the same reason
 * `runCall` and `runCompletedCallPostCall` take a deps object: what a test
 * needs to reach here is the WIRING — that a meeting's outcome becomes this
 * process's exit code — and reaching it must not require a browser, an audio
 * device or a network. Defaulted to the real implementations, so every real
 * caller is unchanged. */
export interface MainDeps {
  meeting?: MeetingJoinDeps;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: MainDeps = {}
): Promise<void> {
  const args = parseParleyArgs(argv);
  switch (args.command) {
    case "serve":
      await serve(args.realtimeProvider ?? "gemini");
      return;
    case "call":
      console.log(
        await runCall(
          {
            to: args.to,
            briefPath: args.briefPath,
            daemonUrl: process.env.PARLEY_DAEMON_URL ?? "http://127.0.0.1:3334",
            callToken: process.env.PARLEY_CALL_TOKEN
          },
          {}
        )
      );
      return;
    case "harness":
      await runHarnessCli(args.rest);
      return;
    // The ONLY place the meeting transport's environment is read. Everything
    // downstream of here — the composition root in @parley/meeting-browser and
    // `runBrowserMeeting` beneath it — takes its configuration as data, which
    // is what lets the whole path be tested with no browser, no audio device
    // and no network. `process.env` is passed rather than consulted there.
    case "meeting": {
      const result = await runMeetingJoin(args.rest, process.env, deps.meeting ?? {});
      console.log(describeMeetingResult(result));
      // A meeting that never happened, or one that broke, must not exit 0.
      // This printed its summary and returned success on a denied join, an
      // expired session, a waiting-room timeout and a non-null capture fault
      // alike — and for a scheduled notetaker the exit code is the only signal
      // a wrapper reads. See `meetingExitCode` for what each code means.
      process.exitCode = meetingExitCode(result);
      return;
    }
    case "doctor":
      console.log(runDoctor({ env: process.env }));
      return;
    default:
      console.log(
        "Usage: parley <serve|call|harness|doctor|meeting>\n" +
          "  call --to <e164> --brief <path>\n" +
          "  harness <preview|scenarios|run-text-preview|reliability> ...\n" +
          "  meeting join <meeting-url> --display-name <name> --records-path <file> " +
          "--audio-device <name>"
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // An operator-facing error's MESSAGE is the whole report — a missing
    // display name, an unreachable Chrome, an audio device that is not there.
    // Printing the Error object instead buries that instruction under a stack
    // trace, at the one moment (a meeting is starting) when there is no time
    // to read one. Everything else keeps its stack: a bug nobody can locate is
    // not a kindness.
    if (isOperatorFacingError(error)) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}

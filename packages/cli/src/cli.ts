#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { canConvert, convert, createAudioCodec } from "@parley/audio";
import { resolveTimeZone } from "@parley/core";
import { runHarnessCli } from "@parley/harness";
import {
  createDeepgramRealtimeProvider,
  DEEPGRAM_SPEED_MAX,
  DEEPGRAM_SPEED_MIN,
  DEFAULT_DEEPGRAM_LISTEN_MODEL,
  DEFAULT_DEEPGRAM_SPEED,
  DEFAULT_DEEPGRAM_THINK,
  DEFAULT_DEEPGRAM_VOICE
} from "@parley/realtime-deepgram";
import { DEFAULT_GEMINI_MODEL, GeminiRealtimeProvider } from "@parley/realtime-gemini";
import {
  describeMeetingResult,
  isOperatorFacingError,
  meetingExitCode,
  runMeetingJoin,
  type MeetingJoinDeps
} from "@parley/meeting-browser";
import {
  createHostAllowlist,
  createNumberAllowlist,
  createParleyServer,
  type BuiltRealtime
} from "@parley/server";
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

/** `PARLEY_DEEPGRAM_SPEED`, or the provider default when unset. Invalid or
 * out-of-range values fail boot naming only the variable — never its value
 * or any credential. */
function resolveDeepgramSpeed(env: NodeJS.ProcessEnv): number {
  const raw = env.PARLEY_DEEPGRAM_SPEED;
  if (!raw) return DEFAULT_DEEPGRAM_SPEED;
  const speed = Number(raw);
  if (!Number.isFinite(speed) || speed < DEEPGRAM_SPEED_MIN || speed > DEEPGRAM_SPEED_MAX) {
    throw new Error(
      `PARLEY_DEEPGRAM_SPEED must be a number from ${DEEPGRAM_SPEED_MIN} to ${DEEPGRAM_SPEED_MAX}`
    );
  }
  return speed;
}

/** Build every realtime provider the environment holds a key for, so the
 * daemon can offer each of them; `--realtime-provider` only picks the default.
 * A provider whose key is absent is simply not built — requiring both keys
 * would break every single-vendor deployment. Takes `env` as a parameter so it
 * is testable without touching `process.env`; keys are read only to hand to the
 * provider constructors and are never logged.
 *
 * The Deepgram `model` is the think model, because that is the model the agent
 * actually runs on and what the call record should name. */
export function buildRealtimeProviders(
  env: NodeJS.ProcessEnv
): Partial<Record<RealtimeProviderKind, BuiltRealtime>> {
  const built: Partial<Record<RealtimeProviderKind, BuiltRealtime>> = {};
  if (env.GEMINI_API_KEY) {
    const model = env.PARLEY_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    built.gemini = { provider: new GeminiRealtimeProvider({ apiKey: env.GEMINI_API_KEY }), model };
  }
  if (env.DEEPGRAM_API_KEY) {
    const think = {
      provider: env.PARLEY_DEEPGRAM_THINK_PROVIDER || DEFAULT_DEEPGRAM_THINK.provider,
      model: env.PARLEY_DEEPGRAM_THINK_MODEL || DEFAULT_DEEPGRAM_THINK.model
    };
    built.deepgram = {
      provider: createDeepgramRealtimeProvider({
        apiKey: env.DEEPGRAM_API_KEY,
        think,
        listenModel: env.PARLEY_DEEPGRAM_LISTEN_MODEL || DEFAULT_DEEPGRAM_LISTEN_MODEL,
        voice: env.PARLEY_DEEPGRAM_VOICE || DEFAULT_DEEPGRAM_VOICE,
        speed: resolveDeepgramSpeed(env)
      }),
      model: think.model
    };
  }
  return built;
}

/** The listening plane a meeting needs — genuinely independent of
 * `buildRealtimeProviders` above (the speaking plane): a meeting under either
 * `--realtime-provider` still needs somewhere to send audio once consent is
 * granted. Optional, unlike a provider key the default needs:
 * a deployment with no transcription plane configured must still be able to
 * place ordinary (non-meeting) calls, so this reads the env var directly
 * rather than through `requireEnv`, and returns undefined rather than
 * throwing when it is unset. `request-handler.ts`'s `handleCall` is what
 * then refuses a meeting envelope at POST /call — see its own doc on
 * `ServerDeps.transcription`.
 *
 * DEEPGRAM_API_KEY is the same variable `buildRealtimeProviders` reads for
 * the Deepgram realtime provider — one Deepgram account key serves both of
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

export { resolveTimeZone };

async function serve(realtimeProviderKind: RealtimeProviderKind): Promise<void> {
  const timeZone = resolveTimeZone(process.env);
  const callRecordsPath = process.env.PARLEY_CALL_RECORDS_PATH;
  const postCallCommand = process.env.PARLEY_POST_CALL_COMMAND;
  // Fail at boot, not on the first call: a default that was never keyed would
  // otherwise surface as a failed call.
  const providers = buildRealtimeProviders(process.env);
  if (!providers[realtimeProviderKind]) {
    throw new Error(`default realtime provider "${realtimeProviderKind}" has no credential`);
  }
  const transcription = buildTranscription();
  const handle = createParleyServer({
    telephony: new TwilioTelephonyProvider({
      accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
      authToken: requireEnv("TWILIO_AUTH_TOKEN")
    }),
    // Every keyed provider, not just the default: a call's envelope may choose
    // any of them (`execution.realtime`), and one naming a provider this
    // daemon holds no key for is refused at POST /call, never re-routed.
    realtime: { providers, default: realtimeProviderKind },
    codec: createAudioCodec(),
    convert,
    canConvert,
    from: requireEnv("TWILIO_FROM_NUMBER"),
    publicHost: requireEnv("PARLEY_PUBLIC_HOST"),
    numberAllowlist: createNumberAllowlist(
      parseCallableNumbers(process.env.PARLEY_CALLABLE_NUMBERS)
    ),
    hostAllowlist: createHostAllowlist([requireEnv("PARLEY_PUBLIC_HOST")]),
    ...(transcription ? { transcription } : {}),
    ...(timeZone ? { timeZone } : {}),
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

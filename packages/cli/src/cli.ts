#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createAudioCodec } from "@parley/audio";
import { runHarnessCli } from "@parley/harness";
import { DEFAULT_GEMINI_MODEL, GeminiRealtimeProvider } from "@parley/realtime-gemini";
import { createHostAllowlist, createNumberAllowlist, createParleyServer } from "@parley/server";
import { TwilioTelephonyProvider } from "@parley/telephony-twilio";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseParleyArgs } from "./args.js";
import { parseCallableNumbers, runCall, runDoctor, runPostCallCommand } from "./commands.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

async function serve(): Promise<void> {
  const callRecordsPath = process.env.PARLEY_CALL_RECORDS_PATH;
  const postCallCommand = process.env.PARLEY_POST_CALL_COMMAND;
  const handle = createParleyServer({
    telephony: new TwilioTelephonyProvider({ accountSid: requireEnv("TWILIO_ACCOUNT_SID"), authToken: requireEnv("TWILIO_AUTH_TOKEN") }),
    realtime: new GeminiRealtimeProvider({ apiKey: requireEnv("GEMINI_API_KEY") }),
    codec: createAudioCodec(),
    from: requireEnv("TWILIO_FROM_NUMBER"),
    publicHost: requireEnv("PARLEY_PUBLIC_HOST"),
    model: DEFAULT_GEMINI_MODEL,
    numberAllowlist: createNumberAllowlist(parseCallableNumbers(process.env.PARLEY_CALLABLE_NUMBERS)),
    hostAllowlist: createHostAllowlist([requireEnv("PARLEY_PUBLIC_HOST")]),
    onCallCompleted: callRecordsPath
      ? (record) => {
          mkdirSync(dirname(callRecordsPath), { recursive: true });
          appendFileSync(callRecordsPath, `${JSON.stringify(record)}\n`, "utf8");
          runPostCallCommand({ command: postCallCommand, recordsPath: callRecordsPath, callId: record.callId }, {});
        }
      : undefined
  });
  const port = Number(process.env.PARLEY_PORT ?? "3334");
  await handle.listen(port);
  console.log(`parley daemon listening on :${port}`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseParleyArgs(argv);
  switch (args.command) {
    case "serve":
      await serve();
      return;
    case "call":
      console.log(await runCall({ to: args.to, briefPath: args.briefPath, daemonUrl: process.env.PARLEY_DAEMON_URL ?? "http://127.0.0.1:3334" }, {}));
      return;
    case "harness":
      await runHarnessCli(args.rest);
      return;
    case "doctor":
      console.log(runDoctor({ env: process.env }));
      return;
    default:
      console.log("Usage: parley <serve|call|harness|doctor>\n  call --to <e164> --brief <path>\n  harness <preview|scenarios|run-text-preview|reliability> ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

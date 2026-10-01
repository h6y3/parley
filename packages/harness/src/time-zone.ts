import { defaultTimeZone, resolveTimeZone } from "@parley/core";

/** The zone a harness run tells the model "today" in: the one the daemon
 * would use — `PARLEY_TIMEZONE` when set, else the host's — so an offline run
 * measures the sentence a real call carries. An invalid name throws, as it
 * does at daemon boot. */
export function harnessTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTimeZone(env) ?? defaultTimeZone();
}

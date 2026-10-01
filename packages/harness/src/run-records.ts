import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioTraceEvent } from "./call-scenario-runner.js";

/** One billed run, as `--transcript <dir>` writes it. A report only counts;
 * reading what a model did (spoke before the callee answered, pressed a key
 * early, said nothing to a derail) needs the run itself, and two builds are
 * only comparable if their runs can be laid side by side. */
export interface RunRecord {
  command: "reliability" | "scenario" | "metamorphic";
  scenarioId: string;
  provider: string;
  model: string;
  /** 1-based, as the report's "run 1/20" lines number them. */
  runIndex: number;
  /** The run's transcript as the command produced it: model and caller events
   * for `reliability`, the spoken text for `scenario` and `metamorphic`. */
  transcript: unknown;
  /** The scenario runner's trace events. Absent for `reliability`, which has none. */
  trace?: readonly ScenarioTraceEvent[];
  /** The verdict with its typed codes. */
  verdict: unknown;
}

const SAFE = /[^A-Za-z0-9._-]/g;

/** `<command>-<scenarioId>-<provider>-<model>-<runIndex>.json`, with every
 * character outside `[A-Za-z0-9._-]` replaced: a model id can hold a slash and
 * a scenario id can hold `::`, and neither may steer the path. */
export function runRecordFileName(record: RunRecord): string {
  return `${[record.command, record.scenarioId, record.provider, record.model, record.runIndex]
    .map((part) => String(part).replace(SAFE, "_"))
    .join("-")}.json`;
}

/** Writes `record` under `dir` (created if missing) and returns the path.
 *
 * The record holds only the fields above, never the environment or the
 * configuration a provider was built from. As a second line of defence,
 * `secrets` are struck from the serialized text, along with their URL-encoded
 * and base64 forms: a vendor diagnostic can echo the URL it connected to, and
 * that URL carries the key. */
export function writeRunRecord(
  dir: string,
  record: RunRecord,
  secrets: readonly string[] = []
): string {
  mkdirSync(dir, { recursive: true });
  let text = JSON.stringify(record, null, 2);
  for (const secret of secrets) {
    if (secret === "") continue;
    // The forms a key takes when a vendor echoes it: as is, in a URL, or in a
    // Basic-style header. Each is also struck in its JSON-escaped form, which
    // is how it sits inside `text`.
    const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")];
    for (const form of new Set(forms)) {
      for (const variant of new Set([form, JSON.stringify(form).slice(1, -1)])) {
        text = text.split(variant).join("[redacted]");
      }
    }
  }
  const path = join(dir, runRecordFileName(record));
  writeFileSync(path, `${text}\n`);
  return path;
}

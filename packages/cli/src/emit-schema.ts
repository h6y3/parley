import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  invariantDescription,
  MEETING_RECORD_INVARIANTS,
  meetingRecordSchema
} from "./meeting-record.js";
import {
  transcriptGapRowSchema,
  transcriptHeaderSchema,
  transcriptRowSchema,
  transcriptUtteranceRowSchema
} from "./transcript-schema.js";

/** The zod schema is the source of truth and this is its cross-language
 * projection. The consumer of a meeting record — and of a transcript — is a
 * Python process in another repository, which cannot import zod — so
 * "validated on write and on read" means zod here and jsonschema there,
 * against these generated files. Commit the output: a consumer must be able
 * to validate without building this repo.
 *
 * The output path is resolved from this module's own location rather than
 * from `process.cwd()`: `pnpm run emit-schema` runs with cwd set to
 * packages/cli (standard pnpm/npm script behaviour), so a bare relative
 * "schema/..." string would land inside the package instead of at the repo
 * root where `schema/` actually lives and where the commit step in this
 * task's brief adds it. dist/emit-schema.js -> packages/cli/dist, three
 * levels up is the repo root. Takes the filename rather than hard-coding
 * one, now that two artifacts (meeting-record, transcript) share it. */
function repoRootSchemaPath(filename: string): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return join(distDir, "..", "..", "..", "schema", filename);
}

/** `meetingRecordSchema`'s cross-cutting invariants are unrepresentable in
 * `zodToJsonSchema`'s output — it projects the object *shape*, not refinement
 * logic. Left unexpressed, an A2 author reading only the schema has no way to
 * learn those invariants exist at all: this whole slice's success condition is
 * "A2 can be written against A1 without asking a question." Draft-07's
 * `if`/`then` can express them, so post-process the generated schema to add
 * them as `allOf` conditions on `MeetingRecord`.
 *
 * This function used to HAND-WRITE that block, with a comment claiming it
 * mirrored the refinement and nothing enforcing the claim. It drifted inside
 * one branch and would have rejected every browser meeting downstream. It now
 * projects `MEETING_RECORD_INVARIANTS` — the same table the refinement itself
 * iterates — so there is no second declaration left to drift from, and adding
 * an invariant here is not a step anyone can forget: it is not a step at all.
 *
 * Nothing in this file decides WHAT an invariant says. Anything that reads
 * like a rule belongs in `meeting-record.ts`'s table; this only formats it.
 *
 * `structuredClone` on `if`/`then`: without it, the objects below are the
 * SAME objects `MEETING_RECORD_INVARIANTS` holds, assigned by reference —
 * `readonly` on `JsonSchemaConditional`'s members stops this file from
 * reassigning them, but does not deep-freeze what they point at, so a caller
 * that post-processes the document this function builds (`main` below writes
 * it verbatim, but `buildMeetingRecordJsonSchema` is also exported for a test
 * to call directly) is mutating the live invariant table for the rest of the
 * process, not a copy of it. */
function addRecordInvariants(schema: Record<string, unknown>): void {
  const definitions = schema.definitions as Record<string, unknown> | undefined;
  const meetingRecord = definitions?.MeetingRecord as Record<string, unknown> | undefined;
  if (!meetingRecord) {
    throw new Error("addRecordInvariants: definitions.MeetingRecord not found in generated schema");
  }
  meetingRecord.allOf = MEETING_RECORD_INVARIANTS.map((invariant) => ({
    description: invariantDescription(invariant),
    if: structuredClone(invariant.jsonSchema.if),
    then: structuredClone(invariant.jsonSchema.then)
  }));
}

/** Builds the JSON Schema document from the current `meetingRecordSchema`.
 * Exported (not just called from `main`) so a test can compare it against
 * the committed file without invoking the CLI or touching disk — see
 * `test/emit-schema.test.ts`. */
export function buildMeetingRecordJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(meetingRecordSchema, {
    name: "MeetingRecord",
    // zod-to-json-schema's DEFAULT for a plain (non-.strict()) z.object() is
    // `additionalProperties: false` — the library picks "reject" as the safe
    // JSON Schema stand-in for zod's actual behaviour ("silently strip",
    // neither reject nor allow). Left at the default, this file would
    // contradict the schema's own "NOT .strict() — additive within a major,
    // unknown fields ignored" comment and its "ignores unknown fields" test:
    // the zod side would accept a 1.1 field and this generated file would
    // reject the exact same record. `removeAdditionalStrategy: "strict"`
    // flips a "strip" object to `additionalProperties: true` instead, which
    // is what a Python `jsonschema` validator needs to match zod's tolerance.
    removeAdditionalStrategy: "strict"
  }) as Record<string, unknown>;
  addRecordInvariants(schema);
  return schema;
}

/** Builds the JSON Schema document for transcript.jsonl from the current
 * `transcript-schema.ts` definitions. Exported for the same reason
 * `buildMeetingRecordJsonSchema` is — a test compares it against the
 * committed file without invoking the CLI or touching disk.
 *
 * `transcriptRowSchema` (the discriminated union of the two body-line
 * shapes) is passed as the emission root, with the header and both row
 * shapes ALSO passed via `definitions` — using the exact same schema
 * instances as the union's own branches. zod-to-json-schema registers each
 * `definitions` entry before walking the root, so when it reaches those same
 * instances again inside the union it emits a `$ref` to the pre-registered
 * definition instead of inlining a second copy. That is what turns the
 * union into `anyOf: [{$ref: .../TranscriptUtteranceRow}, {$ref:
 * .../TranscriptGapRow}]` rather than two duplicated inline object schemas,
 * and is also what makes `TranscriptHeader` reachable at all — it has no
 * connection to the union and would never appear in the output otherwise. */
export function buildTranscriptJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(transcriptRowSchema, {
    name: "TranscriptRow",
    definitions: {
      TranscriptHeader: transcriptHeaderSchema,
      TranscriptUtteranceRow: transcriptUtteranceRowSchema,
      TranscriptGapRow: transcriptGapRowSchema
    },
    // Same reasoning as buildMeetingRecordJsonSchema above: transcript.jsonl
    // is additive-within-a-major with unknown fields ignored too, so a
    // "strip" object must become `additionalProperties: true`, not the
    // library's default `false`.
    removeAdditionalStrategy: "strict"
  }) as Record<string, unknown>;
}

/** Prettier, loaded on demand and only by the renderer that needs it.
 *
 * On demand rather than at the top of this module for two reasons.
 * `buildMeetingRecordJsonSchema` and `buildTranscriptJsonSchema` are imported
 * by a test and must stay loadable without a formatter behind them; and this
 * file compiles into `dist/`, which ships, while prettier is a dev
 * dependency — a static import would put an unresolvable specifier into a
 * published artifact for the sake of a repository-local tool.
 *
 * The failure is turned into an instruction rather than a module-resolution
 * stack, because whoever hits it is an operator regenerating a schema, not
 * someone debugging this file. */
async function loadPrettier(): Promise<typeof import("prettier")> {
  try {
    return await import("prettier");
  } catch (cause) {
    throw new Error(
      "emit-schema: prettier could not be loaded, and it is what makes this generator produce " +
        "the exact bytes the committed schema files hold. Install the repository's dev " +
        "dependencies with `pnpm install`, then re-run " +
        "`pnpm --filter @parley/cli run emit-schema`.",
      { cause }
    );
  }
}

/** One schema document, rendered EXACTLY as the committed file holds it —
 * formatter included.
 *
 * This was `JSON.stringify(document, null, 2)`, which is not the committed
 * form: `schema/` is not in `.prettierignore`, so `pnpm run format`
 * reformats both files, and prettier collapses any array that fits inside
 * `printWidth` onto one line where `JSON.stringify` always breaks it.
 * Measured, not theorised: regenerating without a manual prettier pass
 * produced a 104-line diff across two files nobody had semantically changed.
 * That is a trap this branch has already paid for once, and it would have
 * been paid again on every future regeneration.
 *
 * The knowledge belongs in the generator, not in a runbook — a step an
 * operator has to remember is a step that gets skipped. `resolveConfig` reads
 * the repository's own `.prettierrc.json` from the target path, so this file
 * declares no style of its own and cannot drift from the one `format:check`
 * enforces.
 *
 * The `null, 2` indentation is still what prettier is handed, and it is
 * load-bearing: prettier preserves whether an object was written expanded, so
 * feeding it a single-line document would collapse every object small enough
 * to fit and produce a THIRD form, matching neither the old output nor the
 * committed file.
 *
 * Exported so the staleness test can compare committed BYTES against these
 * bytes. Comparing parsed objects, as it used to, is structurally unable to
 * see a formatting drift — which is why the drift survived. */
export async function renderSchemaDocument(
  filePath: string,
  document: Record<string, unknown>
): Promise<string> {
  const { format, resolveConfig } = await loadPrettier();
  const options = await resolveConfig(filePath);
  return format(`${JSON.stringify(document, null, 2)}\n`, {
    ...options,
    filepath: filePath,
    parser: "json"
  });
}

async function main(): Promise<void> {
  const meetingRecordPath = repoRootSchemaPath("meeting-record.schema.json");
  await mkdir(dirname(meetingRecordPath), { recursive: true });
  await writeFile(
    meetingRecordPath,
    await renderSchemaDocument(meetingRecordPath, buildMeetingRecordJsonSchema())
  );

  const transcriptPath = repoRootSchemaPath("transcript.schema.json");
  await writeFile(
    transcriptPath,
    await renderSchemaDocument(transcriptPath, buildTranscriptJsonSchema())
  );
}

// Guarded exactly like cli.ts's own self-invocation check: without this, the
// unconditional call ran on every IMPORT of this module, not just when
// executed as `node dist/emit-schema.js` — including from
// test/emit-schema.test.ts, which imports `buildMeetingRecordJsonSchema`
// from this same file. That made the staleness guard self-defeating: loading
// the test rewrote the committed schema to match whatever the source
// currently produced, so the comparison could never fail regardless of drift
// (caught live — a mutation test proved the unguarded version silently
// overwrote schema/meeting-record.schema.json on disk mid-test-run).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMeetingRecordJsonSchema,
  buildTranscriptJsonSchema,
  renderSchemaDocument
} from "../src/emit-schema.js";

/** `schema/meeting-record.schema.json` is A2's ONLY source of truth — it is
 * referenced by nothing else in this repo but its own generator, so it can
 * silently go stale the next time `meeting-record.ts` changes and nobody
 * remembers to re-run `emit-schema`. This guards that.
 *
 * Comparison is on the RAW BYTES, and that is a change from what it used to
 * do. It compared parsed objects, with a comment explaining that the
 * generator's own output was not prettier-formatted while the committed file
 * was — an accurate description of a defect, written down as a property of
 * the test instead of being fixed. What it cost: regenerating the schema
 * produced a large diff of pure formatting against files nobody had
 * semantically changed, and the only thing standing between that and a
 * committed mess was somebody remembering to run prettier by hand.
 * `renderSchemaDocument` now produces the committed form itself (see its own
 * doc comment), so a byte comparison is both possible and strictly stronger:
 * a parsed comparison is structurally blind to exactly the drift that
 * happened. */
function repoRootSchemaPath(filename: string): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, "..", "..", "..", "schema", filename);
}

describe("schema/meeting-record.schema.json", () => {
  it("is byte-for-byte what the current meetingRecordSchema would generate", async () => {
    const path = repoRootSchemaPath("meeting-record.schema.json");
    const committed = await readFile(path, "utf8");
    const fresh = await renderSchemaDocument(path, buildMeetingRecordJsonSchema());

    expect(committed).toBe(fresh);
  });
});

/** Same staleness guard as above, for the transcript's own committed schema —
 * `buildTranscriptJsonSchema` is a separate generator (`transcript-schema.ts`
 * is a separate source of truth from `meeting-record.ts`), so it needs its
 * own drift check; passing the meeting-record one proves nothing about this
 * file. */
describe("schema/transcript.schema.json", () => {
  it("is byte-for-byte what the current transcript schemas would generate", async () => {
    const path = repoRootSchemaPath("transcript.schema.json");
    const committed = await readFile(path, "utf8");
    const fresh = await renderSchemaDocument(path, buildTranscriptJsonSchema());

    expect(committed).toBe(fresh);
  });
});

/** The property the byte comparison above rests on, asserted directly so a
 * failure says WHICH half broke.
 *
 * `renderSchemaDocument` has to reproduce the repository's own prettier
 * settings, not a hard-coded style of its own — and the one difference that
 * actually bit is array collapsing: prettier puts a short array on one line
 * where `JSON.stringify(…, 2)` always breaks it one element per line. If this
 * renderer ever stops running prettier, this is the assertion that names the
 * cause rather than dumping a thousand-line diff. */
describe("the renderer produces the committed form, not JSON.stringify's", () => {
  it("collapses a short array onto one line, the way prettier does and JSON.stringify does not", async () => {
    const path = repoRootSchemaPath("meeting-record.schema.json");
    const document = buildMeetingRecordJsonSchema();
    const rendered = await renderSchemaDocument(path, document);
    const stringified = `${JSON.stringify(document, null, 2)}\n`;

    expect(rendered).toContain('"enum": ["far_end", "duration_cap", "transcription_lost"]');
    expect(stringified).not.toContain('"enum": ["far_end", "duration_cap", "transcription_lost"]');
  });
});

/** `removeAdditionalStrategy: "strict"` is a one-word option in
 * `emit-schema.ts` whose entire job is keeping `additionalProperties: true` in
 * both generated documents.
 *
 * zod-to-json-schema's default for a plain (non-`.strict()`) object is
 * `additionalProperties: false` — the library picks "reject" as its JSON
 * Schema stand-in for zod's actual behaviour, which is "silently strip".
 * Neither artifact is `.strict()`, and both are documented as
 * additive-within-a-major with unknown fields ignored, so the default would
 * make the zod side accept a 1.1 field while the committed file a Python
 * consumer validates against rejects the same record.
 *
 * Nothing tested it. Deleting the option left every test in this repository
 * green while every future additive record was rejected downstream — the
 * failure would surface in another repository, on a record this one had
 * happily written. These pin it from both ends: the option's direct effect
 * here, and the consequence in `test/schema-agreement.test.ts`, where an
 * unknown field is validated against both derivations at once. */
describe("both generated schemas tolerate unknown fields, as additive-within-a-major requires", () => {
  it("emits additionalProperties: true on MeetingRecord", () => {
    const schema = buildMeetingRecordJsonSchema() as {
      definitions?: Record<string, { additionalProperties?: unknown }>;
    };
    expect(schema.definitions?.MeetingRecord?.additionalProperties).toBe(true);
  });

  it("emits additionalProperties: true on the transcript header and on both row shapes", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: Record<string, { additionalProperties?: unknown; type?: string }>;
    };
    const definitions = schema.definitions;
    if (!definitions) throw new Error("definitions not found in generated transcript schema");

    for (const name of ["TranscriptHeader", "TranscriptUtteranceRow", "TranscriptGapRow"]) {
      const definition = definitions[name];
      if (!definition) throw new Error(`definitions.${name} not found`);
      expect(definition.additionalProperties, name).toBe(true);
    }
    // Every OBJECT definition, not just the three named above — a fourth
    // added later must not quietly ship as `false`. TranscriptRow is the
    // union and has no `type: "object"` of its own, so it is not one.
    for (const [name, definition] of Object.entries(definitions)) {
      if (definition.type !== "object") continue;
      expect(definition.additionalProperties, name).toBe(true);
    }
  });
});

/** Codifies the manual check this schema was audited with when every zod
 * field in `meeting-record.ts` was given a `.describe()`: A2 is a Python
 * consumer in another repository that cannot see a single TS comment in this
 * one, so a property with no `description` is a property whose meaning only
 * exists here. A hand-run script catches a regression only on the day
 * someone remembers to run it; this catches it on every `pnpm test`. */
interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode & { description?: string }>;
}

function findUndescribed(node: JsonSchemaNode, path = ""): string[] {
  const found: string[] = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const at = path ? `${path}.${key}` : key;
    if (!child.description) found.push(at);
    found.push(...findUndescribed(child, at));
  }
  return found;
}

describe("MeetingRecord's JSON Schema is fully self-explaining", () => {
  it("describes every property, including every property nested inside it", () => {
    const schema = buildMeetingRecordJsonSchema() as {
      definitions?: Record<string, JsonSchemaNode>;
    };
    const meetingRecord = schema.definitions?.MeetingRecord;
    if (!meetingRecord) throw new Error("definitions.MeetingRecord not found in generated schema");

    expect(findUndescribed(meetingRecord)).toEqual([]);
  });
});

/** Content checks on the meeting record's own descriptions, in the same
 * spirit as the transcript's below: a description that merely EXISTS passes
 * the completeness walk above and can still tell a consumer something false.
 *
 * `callId` is the case that motivated these. Its description said the value
 * is "the telephony provider's identifier for this call (its call SID) —
 * assigned by the provider, not Parley" — true of a dialled call, and false
 * of every browser meeting, where there is no provider and the transport
 * mints the id itself. A consumer joining records to a carrier's call logs on
 * that field had been told, in the contract, that it should. */
describe("MeetingRecord's descriptions are true on BOTH transports", () => {
  function propertyDescription(name: string): string {
    const schema = buildMeetingRecordJsonSchema() as {
      definitions?: { MeetingRecord?: { properties?: Record<string, { description?: string }> } };
    };
    return schema.definitions?.MeetingRecord?.properties?.[name]?.description ?? "";
  }

  it("says callId is provider-assigned on telephony and Parley-assigned on a browser meeting", () => {
    const description = propertyDescription("callId");
    expect(description).toContain("telephony");
    expect(description).toContain("browser");
    expect(description.toLowerCase()).toContain("depends on transport");
    expect(description.toLowerCase()).toContain("opaque");
    // The claim that was false on half the records: an unconditional
    // "assigned by the provider, not Parley".
    expect(description).not.toMatch(/^The telephony provider's identifier for this call/);
  });

  it("keeps joinOutcome's own values described, including the one that means the join threw", () => {
    const description = propertyDescription("joinOutcome");
    expect(description).toContain("join_error");
    expect(description).toContain("waiting_room_timeout");
    expect(description.toLowerCase()).toContain("no verdict");
  });
});

/** The transcript schema's root is `TranscriptRow`, an `anyOf` of two `$ref`s
 * (`emit-schema.ts`'s `buildTranscriptJsonSchema` doc comment explains why:
 * the same schema instances are shared between `definitions` and the union,
 * so zod-to-json-schema emits references instead of duplicating the two row
 * shapes inline). `findUndescribed` above only ever walks a node's OWN
 * `.properties` — it was written for MeetingRecord, whose root is a plain
 * object, and it never had a reason to resolve `$ref` or descend into
 * `anyOf`. Handed `TranscriptRow` directly, it would report `[]` immediately:
 * that node has no `.properties` of its own, so the walk would end before
 * ever reaching TranscriptUtteranceRow's or TranscriptGapRow's fields — a
 * clean result that means "did not look", not "found nothing wrong". This is
 * a second, resolving walker built for that shape, not a copy of the first. */
interface ResolvableNode extends JsonSchemaNode {
  description?: string;
  $ref?: string;
  anyOf?: ResolvableNode[];
  oneOf?: ResolvableNode[];
  allOf?: ResolvableNode[];
}

function resolveRef(
  node: ResolvableNode,
  definitions: Record<string, ResolvableNode>
): ResolvableNode {
  if (!node.$ref) return node;
  const name = node.$ref.replace("#/definitions/", "");
  const target = definitions[name];
  if (!target) throw new Error(`findUndescribedResolving: unresolved $ref ${node.$ref}`);
  return target;
}

function findUndescribedResolving(
  node: ResolvableNode,
  definitions: Record<string, ResolvableNode>,
  path = ""
): string[] {
  const resolved = resolveRef(node, definitions);
  const found: string[] = [];
  for (const [key, child] of Object.entries(resolved.properties ?? {})) {
    const at = path ? `${path}.${key}` : key;
    if (!resolveRef(child, definitions).description) found.push(at);
    found.push(...findUndescribedResolving(child, definitions, at));
  }
  for (const branch of [
    ...(resolved.anyOf ?? []),
    ...(resolved.oneOf ?? []),
    ...(resolved.allOf ?? [])
  ]) {
    found.push(...findUndescribedResolving(branch, definitions, path));
  }
  return found;
}

describe("the transcript's JSON Schema is fully self-explaining", () => {
  it("describes every property on the header and on both row shapes, at every nesting level", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: Record<string, ResolvableNode>;
    };
    const definitions = schema.definitions;
    if (!definitions) throw new Error("definitions not found in generated transcript schema");

    // Each definition is checked independently — TranscriptHeader is never
    // reachable FROM TranscriptRow (a header is not a body line), so it would
    // never be visited if only the row union were walked.
    for (const name of ["TranscriptHeader", "TranscriptRow"]) {
      const node = definitions[name];
      if (!node) throw new Error(`definitions.${name} not found in generated transcript schema`);
      expect(findUndescribedResolving(node, definitions), name).toEqual([]);
    }
  });

  /** Content checks, not just presence checks — the task this schema exists
   * for names specific claims each description must carry. A description
   * that merely exists but omits the one fact a consumer needs would pass
   * every test above and still fail the actual requirement. */
  it("documents the append-untimed-last ordering rule on TranscriptRow itself, with its reasoning", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: Record<string, { description?: string }>;
    };
    const description = schema.definitions?.TranscriptRow?.description ?? "";
    expect(description).toContain("APPENDED");
    expect(description).toContain("startMs: null");
    expect(description.toLowerCase()).toContain("false claim");
    expect(description.toLowerCase()).toContain("last line of the file");
  });

  it("enumerates both gap reasons and what each says about the missing audio", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptGapRow?: JsonSchemaNode };
    };
    const description = schema.definitions?.TranscriptGapRow?.properties?.reason?.description ?? "";
    expect(description).toContain("transcriber_connecting");
    expect(description).toContain("transcriber_not_ready");
    expect(description.toLowerCase()).toContain("handoff window");
  });

  it("says a gap is a hole in the record rather than silence in the room", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptGapRow?: { description?: string } };
    };
    const description = schema.definitions?.TranscriptGapRow?.description ?? "";
    expect(description.toLowerCase()).toContain("hole in the");
    expect(description.toLowerCase()).toContain("not evidence of silence");
  });

  it("says speakerId is an explicit null, distinguishing that from an omitted key", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptUtteranceRow?: JsonSchemaNode };
    };
    const description =
      schema.definitions?.TranscriptUtteranceRow?.properties?.speakerId?.description ?? "";
    expect(description).toContain("explicit `null`");
    expect(description.toLowerCase()).toContain("never an omitted key");
  });

  /** The name alone is not the fact. A caption matched within three seconds
   * at 0.6 confidence and a diarization-grade attribution are different
   * claims, and a consumer that puts one in front of a human needs the
   * schema to say which it is holding — these two fields were produced by
   * `attributeEvents` and dropped by the writer, so the committed schema did
   * not mention them at all.
   *
   * ADDITIVE, which is why the two `required` assertions here are now
   * `not.toContain`. They read `toContain` when the fields were introduced,
   * and that is the defect rather than the guard: the consumer validates
   * HISTORICAL transcripts against this same document, every one of them
   * omits both keys, and requiring them invalidated all of them the day they
   * landed. The same branch had already made `joinOutcome` and `transport`
   * optional for exactly this reason. What this test is actually about — the
   * fields exist, and describe what they are worth — is asserted below and
   * unchanged. */
  it("carries where a speakerId came from and what it is worth, without requiring either", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptUtteranceRow?: JsonSchemaNode & { required?: string[] } };
    };
    const row = schema.definitions?.TranscriptUtteranceRow;
    expect(Object.keys(row?.properties ?? {})).toEqual(
      expect.arrayContaining(["speakerSource", "speakerConfidence"])
    );
    expect(row?.required).not.toContain("speakerSource");
    expect(row?.required).not.toContain("speakerConfidence");
    expect(JSON.stringify(row?.properties?.speakerSource)).toContain("roster");
    expect(row?.properties?.speakerConfidence?.description ?? "").toContain("0.6");
  });

  /** `diarized: false` used to be documented as implying every row's
   * speakerId is null. A browser meeting writes false AND attributes every
   * row it can, so a consumer reading the old wording would discard real
   * attribution as impossible. */
  it("does not tell a reader that diarized false means the rows are unattributed", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptHeader?: JsonSchemaNode };
    };
    const description =
      schema.definitions?.TranscriptHeader?.properties?.diarized?.description ?? "";
    expect(description).toContain("speakerSource");
    expect(description).not.toContain("every utterance row's speakerId is therefore null");
  });

  it("says speaker distinguishes the model from the room", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptUtteranceRow?: JsonSchemaNode };
    };
    const description =
      schema.definitions?.TranscriptUtteranceRow?.properties?.speaker?.description ?? "";
    expect(description).toContain('"model" is Parley speaking');
    expect(description.toLowerCase()).toContain("someone in the room");
  });

  it("says only final utterances are ever written, never a later-revised interim", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptUtteranceRow?: JsonSchemaNode };
    };
    const description =
      schema.definitions?.TranscriptUtteranceRow?.properties?.text?.description ?? "";
    expect(description).toContain("Always a FINAL result");
  });

  it("says what timeBase means for reading every other timestamp in the file", () => {
    const schema = buildTranscriptJsonSchema() as {
      definitions?: { TranscriptHeader?: JsonSchemaNode };
    };
    const description =
      schema.definitions?.TranscriptHeader?.properties?.timeBase?.description ?? "";
    expect(description).toContain("startMs/endMs");
    expect(description).toContain("fromMs/toMs");
    expect(description.toLowerCase()).toContain("milliseconds");
  });
});

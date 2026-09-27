import { z } from "zod";

/** The zod schema is the source of truth for `schema/transcript.schema.json`,
 * emitted by `emit-schema.ts` exactly as `meetingRecordSchema` is for
 * `schema/meeting-record.schema.json` — see that file's own top comment for
 * why a generated, committed artifact rather than a hand-written one: A2 is a
 * Python codebase and cannot import zod, so this is the only shape it can
 * validate a transcript row against without reading `transcript-writer.ts`.
 *
 * This does NOT describe a single JSON document, because `transcript.jsonl`
 * is not one — it is JSONL: one header object on line 1, then zero or more
 * body lines, each independently either an "utterance" row or a "gap" row.
 * Flattening that into one permissive object (every field from both shapes,
 * all optional) would let a row missing everything an utterance needs AND
 * everything a gap needs still validate, which defeats the point of having
 * two shapes at all — the `type` discriminator only means something if a row
 * that commits to neither shape is rejected. So this file exports three
 * schemas, each meant to validate a DIFFERENT line of the file, never one
 * wrapper schema for "the file" as a whole: `transcriptHeaderSchema` for
 * line 1, `transcriptRowSchema` (a discriminated union of the two body
 * shapes) for every line after it. */

export const TRANSCRIPT_FORMAT_VERSION = 1;

/** Line 1 of every transcript.jsonl, and the only line of this shape — see
 * `writeTranscriptJsonl` (`transcript-writer.ts`), which builds it as
 * `{ v: 1, ...header, timeBase: "msSinceStartedAt" }`. NOT `.strict()`, for
 * the same reason `meetingRecordSchema` is not: additive-within-a-major,
 * unknown fields ignored, so a v1 reader must tolerate a field a later 1.x
 * writer added. */
export const transcriptHeaderSchema = z.object({
  v: z
    .literal(TRANSCRIPT_FORMAT_VERSION)
    .describe(
      "This file format's own version — always the literal 1. A separate axis from " +
        "MeetingRecord's own `version` field: transcript.jsonl and the record that names it " +
        "(via `transcriptPath`) are two independent artifacts, each free to version on its own " +
        "schedule."
    ),
  callId: z
    .string()
    .min(1)
    .describe(
      "The identifier of the call or meeting this transcript belongs to — the same value as the " +
        "owning MeetingRecord's own `callId`, which is how a consumer joins this file back to " +
        "the record that named its path. Who assigned it depends on the transport; see that " +
        "field's own description in the meeting-record schema. Opaque either way."
    ),
  startedAt: z
    .string()
    .describe(
      "ISO-8601 UTC instant the call began — the same value as the owning MeetingRecord's own " +
        "`startedAt`, and the origin every millisecond timestamp elsewhere in this file " +
        "(startMs/endMs on an utterance row, fromMs/toMs on a gap row) is measured from. See " +
        "timeBase below for the unit."
    ),
  diarized: z
    .boolean()
    .describe(
      "Whether the TRANSCRIPTION PROVIDER attempted to tell separate speakers apart on this " +
        'call. FALSE means diarization was never attempted at all — read it as "not attempted", ' +
        'never as "attempted, and the room turned out to have exactly one speaker", which is a ' +
        "different and stronger claim this field does not make. It is NOT a statement about " +
        "whether the rows below are attributed, and reading it as one is the mistake this " +
        "wording exists to prevent: the browser meeting transport writes false here and still " +
        "populates speakerId on every row it could match, because it attributes speech from the " +
        "meeting's own on-screen captions and captions are not diarization. To learn where a " +
        "row's speakerId came from, read that row's speakerSource; this field answers only what " +
        "the transcription provider did."
    ),
  timeBase: z
    .literal("msSinceStartedAt")
    .describe(
      "The unit and origin for every millisecond timestamp elsewhere in this file: each of " +
        "startMs/endMs (utterance rows) and fromMs/toMs (gap rows) is a count of milliseconds " +
        "elapsed since THIS header's own startedAt — never Unix epoch time, and never relative " +
        'to when consent was granted. Always the single literal value "msSinceStartedAt" in this ' +
        "format version, written out explicitly rather than left for a reader to assume, so a " +
        "future format version that changes the basis has a value to change here rather than " +
        "silently producing timestamps a v1 reader would misread against the wrong origin."
    )
});
export type TranscriptHeader = z.infer<typeof transcriptHeaderSchema>;

/** One spoken utterance. Only a FINAL transcript from its source plane is
 * ever written as a row — `writeTranscriptJsonl` drops every interim on the
 * floor before a row shape is even built (`if (!e.isFinal) continue;`) — so
 * a consumer never has to expect a later row that revises or supersedes an
 * earlier one; every row is final the moment it is read. NOT `.strict()`,
 * same reasoning as the header above. */
export const transcriptUtteranceRowSchema = z.object({
  type: z
    .literal("utterance")
    .describe(
      'Discriminates this row from a gap row ("gap") — read this field first and branch on it. ' +
        "The two row shapes share no other field whose name means the same thing, so `type` is " +
        "the only field a consumer can rely on before knowing which shape the rest of the row is."
    ),
  speaker: z
    .string()
    .describe(
      "Who said this: \"model\" for Parley's own agent, or the far end's speaker tag otherwise — " +
        '"participant" is the only such tag this format version\'s transcription provider ' +
        "produces, so it is the only other value a meeting transcript actually contains today. " +
        'The distinction that matters most to a consumer is the binary one: "model" is Parley ' +
        "speaking, and any other value is someone in the room, not the agent. Left open rather " +
        "than a closed set of values, for the same reason MeetingRecord's own " +
        "`consentReceipt.utterances[].speaker` is (`meeting-record.ts`): a future speaker tag " +
        "must not be rejected by a reader validating against this v1 schema."
    ),
  speakerId: z
    .string()
    .nullable()
    .describe(
      "Opaque identifier attributing this utterance to a specific speaker, stable within the " +
        "call. Written as an explicit `null`, never an omitted key — a reader parsing this file " +
        'one line at a time needs the key present to have an "unattributed" branch from the ' +
        "very first row, rather than discovering the possibility only on some later row that " +
        "happens to omit it. `null` means this utterance was attributed to nobody. A POPULATED " +
        "value says only that something claimed to know who spoke — read speakerSource for what " +
        "made the claim and speakerConfidence for what it is worth, and never take a populated " +
        "speakerId on its own as diarization-grade. The browser meeting transport populates it " +
        "with the display name from the meeting's own live captions, matched to this utterance " +
        'by time, at speakerSource "roster" and speakerConfidence 0.6.'
    ),
  speakerSource: z
    .enum(["channel", "roster", "diarization"])
    .nullable()
    .optional()
    .describe(
      "Where this row's speakerId came from. OPTIONAL, and the distinction between ABSENT and " +
        "null is the whole reason it is: an absent key means the writer recorded no provenance " +
        "at all — which is what every transcript written before this field existed looks like, " +
        "and those files are still read — while an explicit null is a positive statement that " +
        "this row was attributed to nobody. A reader must not collapse the two, and must not " +
        "treat an absent key as a validation failure. Present, it is null exactly when " +
        "speakerId is null. " +
        '"channel": the speaker had an audio channel of their own, so the attribution is a ' +
        'property of the wire rather than an inference. "roster": matched against a participant ' +
        "list or the meeting UI's own live captions — an INFERENCE, whose strength is " +
        'speakerConfidence; this is what the browser meeting transport writes. "diarization": ' +
        "the transcription provider itself separated the speakers. A consumer that puts a name " +
        "in front of a human should branch on this field before doing so: a roster match at 0.6 " +
        "and a channel attribution license very different claims about who said something."
    ),
  speakerConfidence: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional()
    .describe(
      "How much this row's speakerId is worth, from 0 to 1. OPTIONAL for exactly the same " +
        "reason as speakerSource above, and absent means the same thing: no provenance was " +
        "recorded, as in every transcript written before these two fields existed. Present, it " +
        "is null exactly when speakerId is null. Deliberately below 1 for an inferred attribution: the browser meeting transport " +
        "writes 0.6 for a caption line that fell within three seconds of this utterance, which " +
        'says "the meeting UI showed this name speaking around then" and not "this person said ' +
        'this". It qualifies its own speakerSource and does not rank one source against ' +
        "another; do not compare or rescale it across sources."
    ),
  startMs: z
    .number()
    .nullable()
    .describe(
      "Milliseconds since the header's startedAt (see timeBase) that this utterance began, or " +
        "explicit `null` when the plane that produced it reports no timestamps at all — in " +
        "production this is only ever the realtime speaking model, most visibly the turn still " +
        "open when the meeting's consent handoff retires that plane. A `null` here is not only a " +
        "missing value: it changes where this ROW sits in the file. See TranscriptRow's own " +
        "description for the ordering rule this drives — do not assume the file is fully sorted " +
        "by time without checking this field first."
    ),
  endMs: z
    .number()
    .nullable()
    .describe(
      "Milliseconds since the header's startedAt that this utterance ended, or explicit `null` " +
        "under the exact same condition as startMs, which it always accompanies — the two are " +
        "either both a number or both null, never one without the other."
    ),
  text: z
    .string()
    .describe(
      "The utterance's text, as transcribed. Always a FINAL result — see this schema's own top " +
        "comment: an interim transcript from the same plane is filtered out before a row is ever " +
        "built for it, so this text will not later be revised or replaced by a subsequent row " +
        "carrying the same speaker and an overlapping time range."
    )
});
export type TranscriptUtteranceRow = z.infer<typeof transcriptUtteranceRowSchema>;

/** A stretch of the meeting the transcriber did not cover. The top-level
 * `.describe()` below (not just this comment) is what carries "a gap is a
 * hole in the record, not a silence in the room" to a consumer who only ever
 * opens the committed schema — the room may have been talking the entire
 * time this row spans; nothing about a gap row says otherwise, only that
 * none of it reached the transcriber to be written down. NOT `.strict()`,
 * same reasoning as the header above. */
export const transcriptGapRowSchema = z
  .object({
    type: z
      .literal("gap")
      .describe(
        'Discriminates this row from an utterance row ("utterance") — read this field first and ' +
          "branch on it, the same way as for an utterance row; see that row's own type " +
          "description for why."
      ),
    fromMs: z
      .number()
      .describe(
        "Milliseconds since the header's startedAt (see timeBase) marking the start of this gap " +
          "— the instant audio stopped reaching the transcriber."
      ),
    toMs: z
      .number()
      .describe(
        "Milliseconds since the header's startedAt marking the end of this gap — the instant " +
          "audio started reaching the transcriber again."
      ),
    reason: z
      .string()
      .describe(
        "Why this stretch of audio never reached the transcriber. Two values exist in the " +
          'shipped writer: "transcriber_connecting" — the handoff window between consent being ' +
          "granted and the transcription provider's own connection completing (bounded at ten " +
          "seconds); this is the gap essentially every real meeting records, typically a few " +
          'hundred milliseconds long. "transcriber_not_ready" — the transcriber\'s connection ' +
          "dropped and audio arriving in that window was dropped rather than buffered; in the " +
          "shipped implementation this window is only a few frames wide, because a lost " +
          "transcriber connection ends the call rather than continuing to run against it, so " +
          "this value is possible but rare in practice. Left as an open string rather than a " +
          "closed set of two, for the same reason speaker above is: the underlying type this is " +
          "drawn from (TranscriptGap.reason in @parley/core) is itself a bare string, not a " +
          "two-value union, so a v1 reader must not reject a row carrying a reason neither of " +
          "these two names."
      )
  })
  .describe(
    "A stretch of the meeting the transcriber did not cover — a hole in the RECORD, not " +
      "evidence of silence in the room. The room may have been talking the entire time this " +
      "row spans; nothing about a gap row says otherwise, only that none of it reached the " +
      "transcriber to be written down."
  );
export type TranscriptGapRow = z.infer<typeof transcriptGapRowSchema>;

/** Every body line of transcript.jsonl (every line after the header) is one
 * of these two shapes, discriminated by `type`. NOT a single permissive
 * object accepting every field from both shapes as optional: a row that
 * fails to commit to either shape — missing what an utterance needs AND
 * what a gap needs — must be rejected outright, not silently accepted as
 * "a row with some fields". The ordering rule below is carried as an actual
 * `.describe()`, not just this comment, because it is the one piece of
 * reasoning about this format most worth putting in front of whoever reads
 * the committed schema and never opens `transcript-writer.ts` at all. */
export const transcriptRowSchema = z
  .discriminatedUnion("type", [transcriptUtteranceRowSchema, transcriptGapRowSchema])
  .describe(
    "Every body line of transcript.jsonl (every line after the header) is either an " +
      "utterance row or a gap row, discriminated by type; there is no third shape and no " +
      "row is ever a permissive mix of both — a row committing to neither shape is invalid, " +
      "not a lenient partial match. " +
      "ORDERING, the least guessable part of this format: every body line with a known time " +
      "— an utterance's startMs, a gap's fromMs — appears in the file in ascending order by " +
      "that time, interleaved, so a gap between two utterances is always written between " +
      "them, never off to one side; a reader who stops at the first gap row never reads past " +
      "a hole in the record without seeing it. But an utterance can carry startMs: null: the " +
      "realtime speaking-model plane reports no timestamps at all, so the writer has no " +
      "coordinate to place such a row into that timeline. Rather than treat the missing " +
      "value as zero — which would sort the row to the very front, ahead of every gap and " +
      "every other utterance, asserting it was the first thing said on the call, a false " +
      "claim rather than an absent one — every untimed row is APPENDED after every timed " +
      "row instead, in the order it was originally spoken relative to other untimed rows " +
      "only. A model utterance spoken in the first second of the listening window can " +
      "therefore be the LAST line of the file. A reader that assumes this file is fully " +
      "sorted by time, full stop, will misplace such a row — check startMs (utterance) or " +
      "fromMs (gap) for null before trusting a row's position in the file to mean anything " +
      "about when it happened."
  );
export type TranscriptRow = z.infer<typeof transcriptRowSchema>;

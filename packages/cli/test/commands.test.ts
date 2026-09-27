import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompletedCallRecord } from "@parley/server";
import {
  classifyMeetingOutcome,
  parseCallableNumbers,
  runCall,
  runCompletedCallPostCall,
  meetingTranscriptDir,
  runDoctor,
  runMeetingPostCall,
  runMeetingPostCallWithoutConsent,
  runPostCallCommand
} from "../src/commands.js";

const meetingRecordFixture = () => ({
  callId: "CA1",
  startedAt: "2026-08-19T17:00:00.000Z",
  endedAt: "2026-08-19T17:45:00.000Z",
  durationSeconds: 2700,
  status: "completed" as const,
  endedReason: "far_end" as const,
  brief: { title: "Roadmap sync", topic: "Q4 scope", role: "observer", track: ["decisions"] },
  gapMs: 0,
  coveredMs: 2_700_000,
  consentReceipt: {
    requestedAt: "2026-08-19T17:00:00.000Z",
    grantedAt: "2026-08-19T17:00:00.000Z",
    phrase: "go ahead and take notes",
    utterances: []
  }
});

const envelopeFixture = () => ({
  version: 1,
  brief: { to: "+14155550002", persona: "p", objective: "o", facts: [] },
  policy: {
    principalName: "Alex Rivera",
    identity: { style: "self" },
    disclosure: { honestIfAsked: false, volunteer: false },
    scope: { lock: false },
    grounding: { antiInvention: true },
    deferral: { enabled: false },
    authority: {}
  }
});

describe("runCall", () => {
  it("POSTs the envelope file to the daemon and returns the callId", async () => {
    const envelope = envelopeFixture();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })
    ) as unknown as typeof fetch;
    const out = await runCall(
      { to: "+14155550002", briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334" },
      { readFile: () => JSON.stringify(envelope), fetchImpl }
    );
    expect(out).toContain("CA555");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3334/call");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(envelope);
  });

  it("sends the call token as a bearer header when one is configured", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })
    ) as unknown as typeof fetch;
    await runCall(
      { briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334", callToken: "tok-abc" },
      { readFile: () => JSON.stringify(envelopeFixture()), fetchImpl }
    );
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok-abc" });
  });

  it("omits the header entirely when no token is configured, rather than sending an empty one", async () => {
    // `Authorization: Bearer ` would be a token the daemon then has to reject;
    // sending nothing keeps the resulting 401 unambiguous on both sides.
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })
    ) as unknown as typeof fetch;
    await runCall(
      { briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334" },
      { readFile: () => JSON.stringify(envelopeFixture()), fetchImpl }
    );
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty("authorization");
  });

  it("throws when --brief is missing", async () => {
    await expect(
      runCall({ to: "+1", briefPath: undefined, daemonUrl: "http://d" }, {})
    ).rejects.toThrow(/--brief/);
  });

  it("throws when --to disagrees with the envelope's brief recipient", async () => {
    const envelope = envelopeFixture();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })
    ) as unknown as typeof fetch;
    await expect(
      runCall(
        { to: "+19998887777", briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334" },
        { readFile: () => JSON.stringify(envelope), fetchImpl }
      )
    ).rejects.toThrow(/does not match/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not throw when --to matches the envelope's brief recipient", async () => {
    const envelope = envelopeFixture();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })
    ) as unknown as typeof fetch;
    const out = await runCall(
      { to: "+14155550002", briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334" },
      { readFile: () => JSON.stringify(envelope), fetchImpl }
    );
    expect(out).toContain("CA555");
  });
});

describe("parseCallableNumbers", () => {
  it("returns [] when unset", () => {
    expect(parseCallableNumbers(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(parseCallableNumbers("")).toEqual([]);
  });

  it("parses a single number", () => {
    expect(parseCallableNumbers("+14155550002")).toEqual(["+14155550002"]);
  });

  it("trims whitespace and drops empty trailing entries", () => {
    expect(parseCallableNumbers("+14155550002, +14155550003 ,")).toEqual([
      "+14155550002",
      "+14155550003"
    ]);
  });
});

describe("runPostCallCommand", () => {
  it("does nothing when no command or records path is configured", () => {
    const spawnImpl = vi.fn();
    expect(runPostCallCommand({ callId: "CA1" }, { spawnImpl: spawnImpl as never })).toBe(false);
    expect(
      runPostCallCommand({ command: "/bin/echo", callId: "CA1" }, { spawnImpl: spawnImpl as never })
    ).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("starts the configured command with records path and call id", () => {
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    expect(
      runPostCallCommand(
        { command: "/opt/parley/post-call", recordsPath: "/tmp/calls.jsonl", callId: "CA1" },
        { spawnImpl: spawnImpl as never }
      )
    ).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      "/opt/parley/post-call",
      ["--records-path", "/tmp/calls.jsonl", "--call-id", "CA1"],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

describe("runMeetingPostCall", () => {
  it("writes the transcript, then the record, then spawns — in that awaited order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-mpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const order: string[] = [];
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => {
      order.push("spawn");
      return child;
    });

    const ok = await runMeetingPostCall(
      {
        transcriptDir: dir,
        header: { callId: "CA1", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
        events: [{ speaker: "participant", text: "hello", startMs: 0, endMs: 500, isFinal: true }],
        gaps: [],
        record: meetingRecordFixture(),
        command: "/opt/parley/post-call",
        recordsPath
      },
      {
        spawnImpl: spawnImpl as never,
        // Pushed AFTER the real call resolves, not before it starts — this is
        // what actually distinguishes "awaited" from "invoked": dropping the
        // `await` on the append inside `runMeetingPostCall` would leave this
        // array unchanged if pushed on invocation (both calls still fire
        // synchronously in the same tick), but changes the observed order
        // here because completion, not invocation, is what's racing the spawn.
        writeTranscript: async (...args) => {
          const { writeTranscriptJsonl } = await import("../src/transcript-writer.js");
          const result = await writeTranscriptJsonl(...args);
          order.push("transcript");
          return result;
        },
        appendFileImpl: async (...args) => {
          const { appendFile } = await import("node:fs/promises");
          const result = await appendFile(...args);
          order.push("record");
          return result;
        }
      }
    );

    expect(ok).toBe(true);
    expect(order).toEqual(["transcript", "record", "spawn"]);

    const transcriptContents = await readFile(join(dir, "transcript.jsonl"), "utf8");
    expect(transcriptContents).toContain("hello");

    const recordLine = (await readFile(recordsPath, "utf8")).trim();
    const record = JSON.parse(recordLine);
    expect(record.kind).toBe("meeting");
    expect(record.transcriptPath).toBe(join(dir, "transcript.jsonl"));
  });

  it("still writes the transcript, awaited, even when no command is configured to spawn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-mpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const spawnImpl = vi.fn();

    const ok = await runMeetingPostCall(
      {
        transcriptDir: dir,
        header: { callId: "CA2", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
        events: [],
        gaps: [],
        record: { ...meetingRecordFixture(), callId: "CA2" },
        recordsPath
      },
      { spawnImpl: spawnImpl as never }
    );

    expect(ok).toBe(false); // no `command` configured — runPostCallCommand's own gate
    expect(spawnImpl).not.toHaveBeenCalled();
    const transcriptContents = await readFile(join(dir, "transcript.jsonl"), "utf8");
    expect(transcriptContents).toContain('"v":1');
    const record = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(record.callId).toBe("CA2");
  });

  it("creates the records directory when it does not exist yet — a missing directory must not strand a written transcript with no record and no hook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-mpc-"));
    const recordsPath = join(dir, "nested", "does", "not", "exist", "calls.jsonl");

    const ok = await runMeetingPostCall(
      {
        transcriptDir: dir,
        header: { callId: "CA5", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
        events: [],
        gaps: [],
        record: { ...meetingRecordFixture(), callId: "CA5" },
        command: "/opt/parley/post-call",
        recordsPath
      },
      { spawnImpl: vi.fn(() => ({ unref: vi.fn() })) as never }
    );

    expect(ok).toBe(true);
    const record = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(record.callId).toBe("CA5");
  });

  /** Mirrors @parley/meeting-browser's `artifacts.test.ts` "writes nothing at
   * all when the record cannot be built": the record is what anything
   * downstream watches, so a transcript with no record is not a partial
   * success — it is a meeting that silently did not happen, plus a file of
   * what was said in it. `buildMeetingRecord` throws on input its schema
   * refuses (here: `status: "completed"` with no consent receipt), and it
   * used to throw AFTER the transcript was already on disk. */
  it("writes nothing at all when the record cannot be built", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-mpc-"));
    const recordsPath = join(dir, "calls.jsonl");

    await expect(
      runMeetingPostCall(
        {
          transcriptDir: dir,
          header: { callId: "CA8", startedAt: "2026-08-19T17:00:00.000Z", diarized: false },
          events: [
            { speaker: "participant", text: "hello", startMs: 0, endMs: 500, isFinal: true }
          ],
          gaps: [],
          // `status: "completed"` with no consentReceipt violates the
          // record's own consent invariant.
          record: { ...meetingRecordFixture(), callId: "CA8", consentReceipt: null },
          command: "/opt/parley/post-call",
          recordsPath
        },
        { spawnImpl: vi.fn(() => ({ unref: vi.fn() })) as never }
      )
    ).rejects.toThrow();

    expect(await readdir(dir)).toEqual([]);
  });
});

describe("runMeetingPostCallWithoutConsent", () => {
  it("builds a kind:meeting record with transcriptPath and consentReceipt null, writes no transcript at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-mpc-nc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);

    const ok = await runMeetingPostCallWithoutConsent(
      {
        record: {
          callId: "CA6",
          startedAt: "2026-08-19T17:00:00.000Z",
          endedAt: "2026-08-19T17:02:00.000Z",
          durationSeconds: 120,
          status: "consent_refused",
          endedReason: "far_end",
          gapMs: 0,
          coveredMs: 0
        },
        command: "/opt/parley/post-call",
        recordsPath
      },
      { spawnImpl: spawnImpl as never }
    );

    expect(ok).toBe(true);
    expect(spawnImpl).toHaveBeenCalledOnce();

    const record = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(record.kind).toBe("meeting");
    expect(record.status).toBe("consent_refused");
    expect(record.transcriptPath).toBeNull();
    expect(record.consentReceipt).toBeNull();
    // No `brief` key at all — nothing supplies one, and an omitted field
    // reads as "not sourced", never as "sourced empty".
    expect(record).not.toHaveProperty("brief");

    // Nothing named "transcript.jsonl" was ever created in `dir` — this is
    // the case where nothing was recorded, and the record is how a reader
    // learns that happened rather than nothing happening at all.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["calls.jsonl"]);
  });

  it("mkdirs the records directory when missing, same as the with-transcript path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-mpc-nc-"));
    const recordsPath = join(dir, "nested", "calls.jsonl");

    const ok = await runMeetingPostCallWithoutConsent(
      {
        record: {
          callId: "CA7",
          startedAt: "2026-08-19T17:00:00.000Z",
          endedAt: "2026-08-19T17:02:00.000Z",
          durationSeconds: 120,
          status: "consent_timeout",
          endedReason: "far_end",
          gapMs: 0,
          coveredMs: 0
        },
        recordsPath
      },
      {}
    );

    expect(ok).toBe(false); // no `command` configured
    const record = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(record.status).toBe("consent_timeout");
  });
});

describe("classifyMeetingOutcome", () => {
  it("is always 'completed' when a consent receipt exists, regardless of how the call ended", () => {
    for (const endedBy of [
      "model",
      "durationCap",
      "silenceCap",
      "remote",
      "error",
      "consentTimeout",
      "consentDenied",
      "transcriptionLost"
    ] as const) {
      // modelTurnsCompleted is irrelevant once a receipt exists — passed as 1
      // throughout this describe block wherever it doesn't matter to the case
      // under test.
      expect(classifyMeetingOutcome(endedBy, true, 1).status).toBe("completed");
    }
  });

  it("maps the one EndReason that names a consent failure exactly", () => {
    expect(classifyMeetingOutcome("consentTimeout", false, 1).status).toBe("consent_timeout");
  });

  it("a consent timeout outranks 'never_joined' even with zero model turns — reaching the timeout means the request was made", () => {
    expect(classifyMeetingOutcome("consentTimeout", false, 0).status).toBe("consent_timeout");
  });

  // "They said no" and "nobody replied" are different facts about a room's
  // wishes, so CallSession raises them as different EndReasons — but the
  // record's `status` enum has one bucket for "asked and got no yes", and
  // widening it is a change to the schema A2 reads.
  it("maps an explicit refusal to 'consent_refused', distinct from the timeout's own status", () => {
    expect(classifyMeetingOutcome("consentDenied", false, 1).status).toBe("consent_refused");
    expect(classifyMeetingOutcome("consentTimeout", false, 1).status).toBe("consent_timeout");
  });

  it("an explicit refusal outranks 'never_joined' with zero COMPLETED turns — a denial can only be heard inside the consent window, which the agent has to have opened", () => {
    expect(classifyMeetingOutcome("consentDenied", false, 0).status).toBe("consent_refused");
  });

  it("maps our own teardown failing to 'failed', not a consent outcome", () => {
    expect(classifyMeetingOutcome("error", false, 1).status).toBe("failed");
  });

  it("falls back to 'consent_refused' for every other no-receipt ending WITH at least one completed model turn", () => {
    for (const endedBy of [
      "model",
      "durationCap",
      "silenceCap",
      "remote",
      "transcriptionLost"
    ] as const) {
      expect(classifyMeetingOutcome(endedBy, false, 1).status).toBe("consent_refused");
    }
  });

  it("is 'never_joined', not 'consent_refused', when no receipt exists AND no model turn ever completed", () => {
    // The real call's shape: a Zoom dial-in IVR hung up on the agent
    // (endedBy "remote" -> endedReason "far_end") before it ever spoke, so
    // consent was never even asked for. Recording that as "consent_refused"
    // would be a false statement about a room's wishes for a room the agent
    // never reached.
    for (const endedBy of [
      "model",
      "durationCap",
      "silenceCap",
      "remote",
      "transcriptionLost"
    ] as const) {
      expect(classifyMeetingOutcome(endedBy, false, 0).status).toBe("never_joined");
    }
  });

  it("maps endedReason independently of status/receipt", () => {
    // No "removed" arm: nothing can produce that EndReason (a PSTN carrier
    // cannot tell a host removal from a hangup), so it is not in the enum and
    // a host dropping the dial-in reads far_end like any other socket close.
    expect(classifyMeetingOutcome("durationCap", false, 1).endedReason).toBe("duration_cap");
    expect(classifyMeetingOutcome("silenceCap", false, 1).endedReason).toBe("duration_cap");
    expect(classifyMeetingOutcome("transcriptionLost", true, 1).endedReason).toBe(
      "transcription_lost"
    );
    expect(classifyMeetingOutcome("remote", false, 1).endedReason).toBe("far_end");
    expect(classifyMeetingOutcome("model", false, 1).endedReason).toBe("far_end");
    expect(classifyMeetingOutcome("consentTimeout", false, 1).endedReason).toBe("far_end");
    expect(classifyMeetingOutcome("consentDenied", false, 1).endedReason).toBe("far_end");
    expect(classifyMeetingOutcome("error", false, 1).endedReason).toBe("far_end");
  });
});

function completedCallRecordFixture(
  overrides: Partial<CompletedCallRecord> = {}
): CompletedCallRecord {
  return {
    callId: "CA8",
    endedAt: "2026-08-19T17:45:00.000Z",
    transcript: [],
    endedBy: "remote",
    isMeeting: false,
    startedAt: "2026-08-19T17:00:00.000Z",
    gaps: [],
    gapMs: 0,
    coveredMs: 0,
    // Most fixtures below are about a call that got far enough to ask for
    // consent (or further); override to 0 for the "never even reached the
    // room" cases.
    modelTurnsCompleted: 1,
    ...overrides
  };
}

describe("runCompletedCallPostCall — the real production wiring cli.ts calls", () => {
  it("an ordinary (non-meeting) call still gets the plain raw-append behaviour, unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const record = completedCallRecordFixture({ isMeeting: false, callId: "CA-ordinary" });
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));

    await runCompletedCallPostCall(
      {
        record,
        meetingsDir: join(dir, "meetings"),
        recordsPath,
        command: "/opt/parley/post-call"
      },
      { spawnImpl: spawnImpl as never }
    );

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    // The raw CompletedCallRecord, byte for byte — not reshaped into a
    // MeetingRecord, no `kind` field invented for a call that was never one.
    expect(written).toEqual(record);
    expect(spawnImpl).toHaveBeenCalledOnce();

    // No transcript.jsonl anywhere — an ordinary call never gets one.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "meetings"))).toBe(false);
  });

  it("a completed meeting (consent granted) writes transcript.jsonl under meetings/<date>/<callId> and a kind:meeting record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const record = completedCallRecordFixture({
      callId: "CA-meeting-1",
      isMeeting: true,
      endedBy: "remote",
      transcript: [{ speaker: "participant", text: "hi", startMs: 0, endMs: 500, isFinal: true }],
      gaps: [],
      gapMs: 0,
      coveredMs: 500,
      consentReceipt: {
        requestedAt: "2026-08-19T17:00:00.000Z",
        grantedAt: "2026-08-19T17:00:01.000Z",
        phrase: "go ahead",
        matchedPhrase: "go ahead",
        utterances: []
      }
    });

    await runCompletedCallPostCall({ record, meetingsDir: join(dir, "meetings"), recordsPath }, {});

    // meetings/<UTC date of startedAt>/<callId>/ — the date partition is what
    // a retention sweeper selects on without opening a single file.
    const transcriptPath = join(dir, "meetings", "2026-08-19", "CA-meeting-1", "transcript.jsonl");
    const transcriptContents = await readFile(transcriptPath, "utf8");
    expect(transcriptContents).toContain("hi");

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written.kind).toBe("meeting");
    expect(written.status).toBe("completed");
    expect(written.transcriptPath).toBe(transcriptPath);
    expect(written.consentReceipt.phrase).toBe("go ahead");
    // Which utterance actually granted consent — the audit artifact, not
    // just which phrase was configured.
    expect(written.consentReceipt.matchedPhrase).toBe("go ahead");
    // The number `status` was classified from now reaches the artifact,
    // where a reader can verify the classification independently — it used
    // to be computed correctly and then discarded (see meeting-record.ts).
    expect(written.modelTurnsCompleted).toBe(1);
    // This fixture's underlying call declared no execution.meeting.brief —
    // omitted, not stamped with a placeholder. See the "carries brief" and
    // "a title with no track" tests below for the populated cases.
    expect(written).not.toHaveProperty("brief");
  });

  it("carries a fully-supplied brief from the underlying call's execution.meeting.brief into the meeting record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const brief = {
      title: "Roadmap Sync",
      topic: "Q4 scope review.",
      role: "product lead",
      track: ["engineering"]
    };
    const record = completedCallRecordFixture({
      callId: "CA-meeting-brief",
      isMeeting: true,
      endedBy: "remote",
      brief,
      consentReceipt: {
        requestedAt: "2026-08-19T17:00:00.000Z",
        grantedAt: "2026-08-19T17:00:01.000Z",
        phrase: "go ahead",
        matchedPhrase: "go ahead",
        utterances: []
      }
    });

    await runCompletedCallPostCall({ record, meetingsDir: join(dir, "meetings"), recordsPath }, {});

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written.brief).toEqual(brief);
  });

  it("carries a partially-supplied brief through unchanged — a title with no track round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const record = completedCallRecordFixture({
      callId: "CA-meeting-brief-partial",
      isMeeting: true,
      endedBy: "remote",
      brief: { title: "Roadmap Sync" },
      consentReceipt: {
        requestedAt: "2026-08-19T17:00:00.000Z",
        grantedAt: "2026-08-19T17:00:01.000Z",
        phrase: "go ahead",
        matchedPhrase: "go ahead",
        utterances: []
      }
    });

    await runCompletedCallPostCall({ record, meetingsDir: join(dir, "meetings"), recordsPath }, {});

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written.brief).toEqual({ title: "Roadmap Sync" });
  });

  it("carries brief through even when consent was never obtained — brief is call-level config, not a consent-outcome fact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const brief = { title: "Roadmap Sync" };
    const record = completedCallRecordFixture({
      callId: "CA-meeting-brief-refused",
      isMeeting: true,
      endedBy: "remote",
      brief,
      consentReceipt: undefined
    });

    await runCompletedCallPostCall({ record, meetingsDir: join(dir, "meetings"), recordsPath }, {});

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written.status).toBe("consent_refused");
    expect(written.brief).toEqual(brief);
  });

  it("carries answeredBy, outcome and dtmf through into a meeting record — meetings are exactly the calls that press digits to join a bridge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const record = completedCallRecordFixture({
      callId: "CA-meeting-dtmf",
      isMeeting: true,
      endedBy: "remote",
      answeredBy: "human",
      outcome: {
        status: "completed",
        fields: { note: "joined bridge 4" },
        recordedAt: "2026-08-19T17:00:02.000Z"
      },
      dtmf: { pressed: ["4", "#"], refused: 0 },
      consentReceipt: {
        requestedAt: "2026-08-19T17:00:00.000Z",
        grantedAt: "2026-08-19T17:00:01.000Z",
        phrase: "go ahead",
        matchedPhrase: "go ahead",
        utterances: []
      }
    });

    await runCompletedCallPostCall({ record, meetingsDir: join(dir, "meetings"), recordsPath }, {});

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written.answeredBy).toBe("human");
    expect(written.outcome).toEqual({
      status: "completed",
      fields: { note: "joined bridge 4" },
      recordedAt: "2026-08-19T17:00:02.000Z"
    });
    expect(written.dtmf).toEqual({ pressed: ["4", "#"], refused: 0 });
  });

  it("omits answeredBy, outcome and dtmf entirely when the underlying call carried none — never stamps false/empty defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const record = completedCallRecordFixture({
      callId: "CA-meeting-no-dtmf",
      isMeeting: true,
      endedBy: "remote",
      consentReceipt: {
        requestedAt: "2026-08-19T17:00:00.000Z",
        grantedAt: "2026-08-19T17:00:01.000Z",
        phrase: "go ahead",
        matchedPhrase: "go ahead",
        utterances: []
      }
    });

    await runCompletedCallPostCall({ record, meetingsDir: join(dir, "meetings"), recordsPath }, {});

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written).not.toHaveProperty("answeredBy");
    expect(written).not.toHaveProperty("outcome");
    expect(written).not.toHaveProperty("dtmf");
  });

  it("a meeting whose consent timed out writes a kind:meeting record with a null transcriptPath and NO transcript.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "calls.jsonl");
    const record = completedCallRecordFixture({
      callId: "CA-meeting-2",
      isMeeting: true,
      endedBy: "consentTimeout",
      consentReceipt: undefined
    });

    await runCompletedCallPostCall({ record, meetingsDir: join(dir, "meetings"), recordsPath }, {});

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written.kind).toBe("meeting");
    expect(written.status).toBe("consent_timeout");
    expect(written.transcriptPath).toBeNull();
    expect(written.consentReceipt).toBeNull();

    const { existsSync } = await import("node:fs");
    expect(
      existsSync(join(dir, "meetings", "2026-08-19", "CA-meeting-2", "transcript.jsonl"))
    ).toBe(false);
  });

  it("a meeting whose own teardown failed is 'failed', a meeting that simply never reached consent is 'consent_refused'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));

    const failedRecordsPath = join(dir, "failed.jsonl");
    await runCompletedCallPostCall(
      {
        record: completedCallRecordFixture({
          callId: "CA-failed",
          isMeeting: true,
          endedBy: "error",
          consentReceipt: undefined
        }),
        meetingsDir: join(dir, "meetings"),
        recordsPath: failedRecordsPath
      },
      {}
    );
    expect(JSON.parse((await readFile(failedRecordsPath, "utf8")).trim()).status).toBe("failed");

    const refusedRecordsPath = join(dir, "refused.jsonl");
    await runCompletedCallPostCall(
      {
        record: completedCallRecordFixture({
          callId: "CA-refused",
          isMeeting: true,
          endedBy: "remote",
          consentReceipt: undefined,
          modelTurnsCompleted: 1 // the model spoke and asked; the room just never said yes
        }),
        meetingsDir: join(dir, "meetings"),
        recordsPath: refusedRecordsPath
      },
      {}
    );
    const refused = JSON.parse((await readFile(refusedRecordsPath, "utf8")).trim());
    expect(refused.status).toBe("consent_refused");
    // The number the classification rested on is now IN the artifact, not
    // just in the process that produced it — a reader can confirm "at least
    // one model turn completed" independently of trusting the code.
    expect(refused.modelTurnsCompleted).toBe(1);
  });

  it("a meeting that never reached the room at all is 'never_joined', not 'consent_refused' — the real call's shape", async () => {
    // Reproduces the live call this fix was found from: a Zoom dial-in IVR
    // hung up on the agent after three DTMF presses, 32.7s in, before it
    // ever spoke a word. `consent_refused` there would be a false statement
    // about a room's wishes — the agent never reached the room to ask.
    const dir = await mkdtemp(join(tmpdir(), "parley-ccpc-"));
    const recordsPath = join(dir, "never-joined.jsonl");

    await runCompletedCallPostCall(
      {
        record: completedCallRecordFixture({
          callId: "CA-never-joined",
          isMeeting: true,
          endedBy: "remote", // Zoom hung up — the far end going away
          consentReceipt: undefined,
          transcript: [],
          modelTurnsCompleted: 0, // never got a chance to speak
          dtmf: {
            pressed: ["55501234567#", "55501234567#", "55501234567#"],
            refused: 0
          }
        }),
        meetingsDir: join(dir, "meetings"),
        recordsPath
      },
      {}
    );

    const written = JSON.parse((await readFile(recordsPath, "utf8")).trim());
    expect(written.kind).toBe("meeting");
    expect(written.status).toBe("never_joined");
    expect(written.endedReason).toBe("far_end");
    expect(written.transcriptPath).toBeNull();
    expect(written.consentReceipt).toBeNull();
    // The loose end this fix closes: `modelTurnsCompleted` drove the
    // `never_joined` classification above but, before this change, never
    // reached the written artifact at all — a reader could not tell "this
    // really is 0" from "the field just isn't here". It is here now, and it
    // is 0, which is what makes "never_joined" verifiable rather than
    // asserted.
    expect(written.modelTurnsCompleted).toBe(0);

    const { existsSync } = await import("node:fs");
    expect(
      existsSync(join(dir, "meetings", "2026-08-19", "CA-never-joined", "transcript.jsonl"))
    ).toBe(false);
  });
});

describe("runDoctor", () => {
  it("reports presence booleans and never prints secret values", () => {
    const out = runDoctor({
      env: {
        GEMINI_API_KEY: "sekret",
        TWILIO_AUTH_TOKEN: "",
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_FROM_NUMBER: "+1",
        DEEPGRAM_API_KEY: "another-sekret"
      }
    });
    expect(out).toContain("GEMINI_API_KEY: present");
    expect(out).toContain("TWILIO_AUTH_TOKEN: MISSING");
    expect(out).not.toContain("sekret");
    expect(out).not.toContain("another-sekret");
  });

  // Meetings are reported as a CAPABILITY, not as presence lines. Listing
  // DEEPGRAM_API_KEY beside the boot-required secrets printed MISSING on a
  // Gemini-only deployment that never intended to take a meeting, which is
  // not a fault and cost an operator a triage every time they read it.
  it("reports meetings ready only when BOTH the listening plane and the artifact sink are configured", () => {
    expect(
      runDoctor({ env: { DEEPGRAM_API_KEY: "k", PARLEY_CALL_RECORDS_PATH: "/tmp/calls.jsonl" } })
    ).toContain("meetings: ready");
  });

  it("names exactly what a meeting is missing, and never calls it a fault when neither is set", () => {
    const out = runDoctor({ env: {} });
    expect(out).toContain(
      "meetings: not configured (needs DEEPGRAM_API_KEY, PARLEY_CALL_RECORDS_PATH)"
    );
    expect(out).not.toContain("DEEPGRAM_API_KEY: MISSING");
  });

  it("names the artifact sink alone when only the listening plane is configured — the half-configured daemon that accepted meetings and wrote nothing", () => {
    const out = runDoctor({ env: { DEEPGRAM_API_KEY: "k" } });
    expect(out).toContain("meetings: not configured (needs PARLEY_CALL_RECORDS_PATH)");
  });
});

/** Contract 5 to A2: deterministic, date-partitioned paths. A retention
 * sweeper and a story-24 reader both have to find a meeting's files without
 * being told where, and a flat `<callId>/` tree makes "which of these is old"
 * a question you can only answer by opening every file. */
describe("meetingTranscriptDir", () => {
  it("partitions by the UTC date of startedAt, then by callId", () => {
    expect(meetingTranscriptDir("/r/meetings", "2026-08-19T17:00:00.000Z", "CA1")).toBe(
      join("/r/meetings", "2026-08-19", "CA1")
    );
  });

  it("files a meeting that runs past midnight under the day it BEGAN", () => {
    expect(meetingTranscriptDir("/r/meetings", "2026-08-19T23:40:00.000Z", "CA1")).toBe(
      join("/r/meetings", "2026-08-19", "CA1")
    );
  });
});

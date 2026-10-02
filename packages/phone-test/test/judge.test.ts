import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JUDGE_PROMPT,
  callTranscript,
  createGeminiJudge,
  judgePair,
  winRates,
  type JudgeClient,
  type JudgeInput,
  type JudgeVerdict,
  type PairJudgement
} from "../src/judge.js";
import type { CallResult } from "../src/runner.js";

const dir = mkdtempSync(join(tmpdir(), "parley-judge-"));

function call(config: string, over: Partial<CallResult> = {}): CallResult {
  const wavPath = join(dir, `${config}.wav`);
  writeFileSync(wavPath, `stereo:${config}`);
  return {
    tag: `t.${config}`,
    scenarioId: "dental-reschedule",
    persona: "maria",
    config,
    callId: `call-${config}`,
    wavPath,
    record: {
      callId: `call-${config}`,
      transcript: [
        { speaker: "caller", text: "Hello, ", isFinal: false },
        { speaker: "caller", text: "dental office.", isFinal: false },
        { speaker: "model", text: `Hi, this is ${config}.`, isFinal: true }
      ]
    },
    minutes: 1,
    usd: 0.1,
    errors: [],
    ...over
  };
}

/** Fake split: tags each channel with the stereo file's contents. */
const split = (wav: Buffer): { agent: Buffer; callee: Buffer } => ({
  agent: Buffer.from(`agent<${wav.toString()}>`),
  callee: Buffer.from(`callee<${wav.toString()}>`)
});

/** A judge that always prefers one config's agent, whichever slot it sits in. */
function prefers(config: string | "tie", log: JudgeInput[] = []): JudgeClient {
  return {
    compare(input) {
      log.push(input);
      const aIs = input.aAgentWav.toString().includes(`stereo:${config}`);
      const bIs = input.bAgentWav.toString().includes(`stereo:${config}`);
      const preferred = aIs ? "A" : bIs ? "B" : "tie";
      return Promise.resolve({ preferred, confidence: 0.8, reason: `r-${preferred}` });
    }
  };
}

/** A judge that always answers the same slot — pure position bias. */
function slot(preferred: JudgeVerdict["preferred"]): JudgeClient {
  return { compare: () => Promise.resolve({ preferred, confidence: 0.6, reason: "slot" }) };
}

describe("judgePair", () => {
  it("names the winner when both orders agree", async () => {
    const log: JudgeInput[] = [];
    const r = await judgePair(call("gemini"), call("deepgram"), prefers("deepgram", log), split);
    expect(r.winner).toBe("deepgram");
    expect(r.agreement).toBe(true);
    expect(r.configs).toEqual(["gemini", "deepgram"]);
    expect(r.reasons).toEqual(["r-B", "r-A"]);
    expect(r.confidences).toEqual([0.8, 0.8]);
    // A/B first, then B/A.
    expect(log[0]!.aAgentWav.toString()).toBe("agent<stereo:gemini>");
    expect(log[0]!.bCalleeWav.toString()).toBe("callee<stereo:deepgram>");
    expect(log[1]!.aAgentWav.toString()).toBe("agent<stereo:deepgram>");
    expect(log[1]!.bAgentWav.toString()).toBe("agent<stereo:gemini>");
  });

  it("is a tie without agreement when the orders disagree", async () => {
    const r = await judgePair(call("gemini"), call("deepgram"), slot("A"), split);
    expect(r).toMatchObject({ winner: "tie", agreement: false });
    expect(r.reasons).toHaveLength(2);
  });

  it("is a tie without agreement when only one order picks a side", async () => {
    let n = 0;
    const client: JudgeClient = {
      compare: () =>
        Promise.resolve({ preferred: n++ === 0 ? "A" : "tie", confidence: 0.5, reason: "x" })
    };
    const r = await judgePair(call("gemini"), call("deepgram"), client, split);
    expect(r).toMatchObject({ winner: "tie", agreement: false });
  });

  it("carries both calls' tags, in the order passed", async () => {
    const r = await judgePair(call("gemini"), call("deepgram"), slot("tie"), split);
    expect(r.tags).toEqual(["t.gemini", "t.deepgram"]);
  });

  it("is an agreed tie when both orders say tie", async () => {
    const r = await judgePair(call("gemini"), call("deepgram"), slot("tie"), split);
    expect(r).toMatchObject({ winner: "tie", agreement: true });
  });

  it("labels the transcript from the call record", async () => {
    const log: JudgeInput[] = [];
    await judgePair(call("gemini"), call("deepgram"), prefers("tie", log), split);
    expect(log[0]!.aTranscript).toBe(
      "CALLEE: Hello,\nCALLEE: dental office.\nAGENT: Hi, this is gemini."
    );
  });

  it("refuses calls of different scenarios or personas, the same config, or no audio", async () => {
    const j = prefers("tie");
    await expect(
      judgePair(call("gemini"), call("deepgram", { persona: "other" }), j, split)
    ).rejects.toThrow("judge-mismatch");
    await expect(judgePair(call("gemini"), call("gemini"), j, split)).rejects.toThrow(
      "judge-mismatch"
    );
    await expect(
      judgePair(call("gemini"), call("deepgram", { wavPath: undefined }), j, split)
    ).rejects.toThrow("judge-no-audio");
  });
});

describe("callTranscript", () => {
  it("makes every record entry its own line, whatever its isFinal", () => {
    // Records are already coalesced per turn: an entry is a turn.
    const r = call("x", {
      record: {
        transcript: [
          { speaker: "caller", text: "Hello, dental office.", isFinal: false },
          { speaker: "caller", text: "How can I help?", isFinal: true },
          { speaker: "model", text: "  Hi there,  this is Ava. ", isFinal: false },
          { speaker: "model", text: "Bye.", isFinal: true },
          { speaker: "caller", text: "  ", isFinal: false },
          { speaker: "caller", isFinal: true }
        ]
      }
    });
    expect(callTranscript(r)).toBe(
      "CALLEE: Hello, dental office.\nCALLEE: How can I help?\nAGENT: Hi there, this is Ava.\nAGENT: Bye."
    );
  });

  it("falls back to the sim's calleeText when the record is missing", () => {
    const timelinePath = join(dir, "timeline.json");
    writeFileSync(timelinePath, JSON.stringify({ events: [], calleeText: ["Hello?", "Bye."] }));
    const r = call("x", { record: undefined, timelinePath });
    expect(callTranscript(r)).toBe("CALLEE: Hello?\nCALLEE: Bye.");
    expect(callTranscript(call("x", { record: undefined }))).toBe("");
  });
});

describe("winRates", () => {
  const p = (winner: string, configs: [string, string], agreement = true): PairJudgement => ({
    winner,
    agreement,
    configs,
    tags: ["ta", "tb"],
    reasons: [],
    confidences: []
  });

  it("is wins over order-agreed decided comparisons; ties leave the denominator", () => {
    const rates = winRates([
      p("deepgram", ["gemini", "deepgram"]),
      p("deepgram", ["deepgram", "gemini"]),
      p("gemini", ["gemini", "deepgram"]),
      p("tie", ["gemini", "deepgram"], false),
      p("tie", ["gemini", "deepgram"], true),
      p("deepgram", ["deepgram", "other"])
    ]);
    // deepgram: 3 wins of 4 decided; gemini: 1 of 3; other: 0 of 1.
    expect(rates).toEqual({ deepgram: 0.75, gemini: 1 / 3, other: 0 });
  });

  it("leaves out a config with no decided comparison", () => {
    expect(winRates([p("tie", ["a", "b"], false)])).toEqual({});
    expect(winRates([])).toEqual({});
  });
});

describe("JUDGE_PROMPT", () => {
  it("ignores line and codec artefacts but judges a synthetic-sounding voice", () => {
    expect(JUDGE_PROMPT).not.toContain("Ignore audio quality");
    expect(JUDGE_PROMPT).toMatch(/telephone-line and codec artefacts/);
    expect(JUDGE_PROMPT).toMatch(/noise, narrow bandwidth, compression/);
    expect(JUDGE_PROMPT).toMatch(/agent's voice itself sounds synthetic or human/);
  });
});

describe("createGeminiJudge", () => {
  const input: JudgeInput = {
    aAgentWav: Buffer.from("aa"),
    aCalleeWav: Buffer.from("ac"),
    aTranscript: "AGENT: hi A",
    bAgentWav: Buffer.from("ba"),
    bCalleeWav: Buffer.from("bc"),
    bTranscript: "AGENT: hi B"
  };
  const reply = (text: string, status = 200): Response =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status,
      headers: { "content-type": "application/json" }
    });

  function capture(res: () => Response): {
    fetch: typeof fetch;
    calls: { url: string; init: RequestInit }[];
  } {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = ((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(res());
    }) as unknown as typeof fetch;
    return { fetch: f, calls };
  }

  const ok = () => reply(JSON.stringify({ preferred: "B", confidence: 0.7, reason: "smoother" }));

  it("sends four mono WAV parts, both transcripts and the fixed prompt", async () => {
    const { fetch, calls } = capture(ok);
    const v = await createGeminiJudge({ apiKey: "k-secret", fetch }).compare(input);
    expect(v).toEqual({ preferred: "B", confidence: 0.7, reason: "smoother" });

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      contents: { role: string; parts: Record<string, unknown>[] }[];
      generationConfig: Record<string, unknown>;
    };
    const parts = body.contents[0]!.parts;
    const audio = parts.filter((x) => "inline_data" in x) as {
      inline_data: { mime_type: string; data: string };
    }[];
    expect(audio).toHaveLength(4);
    expect(audio.every((x) => x.inline_data.mime_type === "audio/wav")).toBe(true);
    expect(audio.map((x) => Buffer.from(x.inline_data.data, "base64").toString())).toEqual([
      "aa",
      "ac",
      "ba",
      "bc"
    ]);
    const text = parts.map((x) => x.text).filter(Boolean);
    expect(text[0]).toBe(JUDGE_PROMPT);
    expect(text).toContain("Call A — agent audio");
    expect(text).toContain("Call B — callee audio");
    expect(text.join("\n")).toContain("AGENT: hi A");
    expect(text.join("\n")).toContain("AGENT: hi B");
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      temperature: 0
    });
  });

  it("puts the model in the URL path and the key in a header, never the URL", async () => {
    const { fetch, calls } = capture(ok);
    await createGeminiJudge({ apiKey: "k-secret", fetch }).compare(input);
    await createGeminiJudge({ apiKey: "k-secret", model: "gemini-x", fetch }).compare(input);
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    );
    expect(calls[1]!.url).toContain("/models/gemini-x:generateContent");
    expect(calls[0]!.url).not.toContain("k-secret");
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-secret");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it.each([
    "not json",
    JSON.stringify({ preferred: "C", confidence: 0.5, reason: "x" }),
    JSON.stringify({ preferred: "A", confidence: "high", reason: "x" }),
    JSON.stringify({ preferred: "A", confidence: 0.5 })
  ])("throws judge-unparseable on a malformed verdict: %s", async (text) => {
    const { fetch } = capture(() => reply(text));
    await expect(createGeminiJudge({ apiKey: "k", fetch }).compare(input)).rejects.toThrow(
      "judge-unparseable"
    );
  });

  it("throws judge-unparseable on a reply with no candidates", async () => {
    const { fetch } = capture(() => new Response("{}", { status: 200 }));
    await expect(createGeminiJudge({ apiKey: "k", fetch }).compare(input)).rejects.toThrow(
      "judge-unparseable"
    );
  });

  it("reports a failed request by status only — no key, no body", async () => {
    const { fetch } = capture(() => new Response("bad key k-secret echoed", { status: 403 }));
    const err = await createGeminiJudge({ apiKey: "k-secret", fetch })
      .compare(input)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("judge request failed: 403");
  });

  it("reports a network failure without its cause", async () => {
    const failing = (() =>
      Promise.reject(new Error("boom k-secret"))) as unknown as typeof globalThis.fetch;
    const err = await createGeminiJudge({ apiKey: "k-secret", fetch: failing })
      .compare(input)
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe("judge request failed");
  });
});

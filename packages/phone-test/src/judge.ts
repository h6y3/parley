import { readFileSync } from "node:fs";
import type { CallResult } from "./runner.js";

/** One comparison's audio and transcripts. Every WAV is mono. */
export interface JudgeInput {
  aAgentWav: Buffer;
  aCalleeWav: Buffer;
  aTranscript: string;
  bAgentWav: Buffer;
  bCalleeWav: Buffer;
  bTranscript: string;
}

export interface JudgeVerdict {
  preferred: "A" | "B" | "tie";
  confidence: number;
  reason: string;
}

export interface JudgeClient {
  compare(input: JudgeInput): Promise<JudgeVerdict>;
}

export interface GeminiJudgeOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_JUDGE_MODEL = "gemini-3.8-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const JUDGE_TIMEOUT_MS = 120_000;

/** The fixed instruction the judge gets for every comparison. */
export const JUDGE_PROMPT = [
  "You will hear two recorded phone calls, Call A and Call B, of the same scenario.",
  "In each call an AGENT (an assistant phoning on someone's behalf) talks to a CALLEE.",
  "Each call comes as separate agent audio, callee audio and a transcript.",
  "",
  "Judge ONLY which call's AGENT sounds more like a natural, competent human assistant on a phone call, on:",
  "- voice: prosody and pacing;",
  "- wording: natural rather than scripted or stiff;",
  "- turn-taking: gaps before replies, talking over the callee, handling interruptions.",
  "",
  "Ignore the callee's voice.",
  "Ignore telephone-line and codec artefacts (noise, narrow bandwidth, compression),",
  "but do judge whether the agent's voice itself sounds synthetic or human.",
  "Ignore which configuration or provider produced either call.",
  'Answer "tie" when there is no clear difference.',
  'Reply with JSON: preferred ("A", "B" or "tie"), confidence (0 to 1), and reason (one sentence).'
].join("\n");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    preferred: { type: "STRING", enum: ["A", "B", "tie"] },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" }
  },
  required: ["preferred", "confidence", "reason"]
};

const wavPart = (wav: Buffer): Record<string, unknown> => ({
  inline_data: { mime_type: "audio/wav", data: wav.toString("base64") }
});

function parseVerdict(body: unknown): JudgeVerdict {
  const fail = (): never => {
    throw new Error("judge-unparseable");
  };
  const parts = (body as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return fail();
  const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail();
  }
  const { preferred, confidence, reason } = (v ?? {}) as Record<string, unknown>;
  if (preferred !== "A" && preferred !== "B" && preferred !== "tie") return fail();
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return fail();
  if (typeof reason !== "string") return fail();
  return { preferred, confidence: Math.min(1, Math.max(0, confidence)), reason };
}

/** A judge on Gemini's audio understanding. The key travels in the
 * `x-goog-api-key` header, never the URL; a failed request reports its status
 * only, never the key or the response body. */
export function createGeminiJudge(opts: GeminiJudgeOptions): JudgeClient {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
  return {
    async compare(input) {
      const parts = [
        { text: JUDGE_PROMPT },
        { text: "Call A — agent audio" },
        wavPart(input.aAgentWav),
        { text: "Call A — callee audio" },
        wavPart(input.aCalleeWav),
        { text: `Call A — transcript\n${input.aTranscript}` },
        { text: "Call B — agent audio" },
        wavPart(input.bAgentWav),
        { text: "Call B — callee audio" },
        wavPart(input.bCalleeWav),
        { text: `Call B — transcript\n${input.bTranscript}` }
      ];
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: RESPONSE_SCHEMA,
              temperature: 0
            }
          }),
          signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS)
        });
      } catch {
        throw new Error("judge request failed");
      }
      if (!res.ok) throw new Error(`judge request failed: ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error("judge-unparseable");
      }
      return parseVerdict(body);
    }
  };
}

interface RecordEntry {
  speaker?: unknown;
  text?: unknown;
}

/** A call's transcript as "AGENT:" / "CALLEE:" lines, from the daemon's call
 * record (`model` is the agent; every far-end speaker is the callee). Records
 * are already coalesced per turn, so every entry is its own line, whatever its
 * `isFinal`. With no record, the sim's own `calleeText` stands in, as CALLEE
 * lines only. */
export function callTranscript(call: CallResult): string {
  const entries = (call.record as { transcript?: unknown } | undefined)?.transcript;
  if (!Array.isArray(entries)) return fallbackTranscript(call.timelinePath);
  return (entries as RecordEntry[])
    .filter((e) => typeof e?.text === "string")
    .map((e) => ({
      who: e.speaker === "model" ? "AGENT" : "CALLEE",
      text: (e.text as string).replace(/\s+/g, " ").trim()
    }))
    .filter((l) => l.text !== "")
    .map((l) => `${l.who}: ${l.text}`)
    .join("\n");
}

function fallbackTranscript(timelinePath: string | undefined): string {
  if (!timelinePath) return "";
  try {
    const t = JSON.parse(readFileSync(timelinePath, "utf8")) as { calleeText?: unknown };
    if (!Array.isArray(t.calleeText)) return "";
    return t.calleeText
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x) => `CALLEE: ${x.trim()}`)
      .join("\n");
  } catch {
    return "";
  }
}

export interface PairJudgement {
  /** The winning config's name, or "tie". */
  winner: string;
  /** Whether the A/B and B/A verdicts named the same winner (or both tie). */
  agreement: boolean;
  /** The two configs compared, in the order passed. */
  configs: [string, string];
  /** The two calls' tags, in the same order. */
  tags: [string, string];
  /** The judge's reasons, A/B order first. */
  reasons: string[];
  confidences: number[];
}

/** Judges two calls of the same scenario and persona under two configs, A/B
 * then B/A. A config wins only when both orders pick it; any disagreement is a
 * tie with `agreement: false`, which cancels the judge's position bias. */
export async function judgePair(
  a: CallResult,
  b: CallResult,
  client: JudgeClient,
  splitChannels: (wav: Buffer) => { agent: Buffer; callee: Buffer }
): Promise<PairJudgement> {
  if (a.scenarioId !== b.scenarioId || a.persona !== b.persona || a.config === b.config) {
    throw new Error("judge-mismatch: a pair is one scenario and persona under two configs");
  }
  if (!a.wavPath || !b.wavPath) throw new Error("judge-no-audio");
  const sa = splitChannels(readFileSync(a.wavPath));
  const sb = splitChannels(readFileSync(b.wavPath));
  const ta = callTranscript(a);
  const tb = callTranscript(b);

  const ab = await client.compare({
    aAgentWav: sa.agent,
    aCalleeWav: sa.callee,
    aTranscript: ta,
    bAgentWav: sb.agent,
    bCalleeWav: sb.callee,
    bTranscript: tb
  });
  const ba = await client.compare({
    aAgentWav: sb.agent,
    aCalleeWav: sb.callee,
    aTranscript: tb,
    bAgentWav: sa.agent,
    bCalleeWav: sa.callee,
    bTranscript: ta
  });

  const pick = (v: JudgeVerdict, slotA: string, slotB: string): string =>
    v.preferred === "A" ? slotA : v.preferred === "B" ? slotB : "tie";
  const first = pick(ab, a.config, b.config);
  const second = pick(ba, b.config, a.config);
  const agreement = first === second;
  return {
    winner: agreement ? first : "tie",
    agreement,
    configs: [a.config, b.config],
    tags: [a.tag, b.tag],
    reasons: [ab.reason, ba.reason],
    confidences: [ab.confidence, ba.confidence]
  };
}

/** Each config's win rate:
 *
 *   rate(c) = wins(c) / decided(c)
 *
 * where decided(c) counts the pairs involving c that were order-agreed AND
 * named a winner. Ties — agreed or not — leave the denominator. A config with
 * no decided pair is left out rather than reported as 0. */
export function winRates(pairs: PairJudgement[]): Record<string, number> {
  const wins = new Map<string, number>();
  const decided = new Map<string, number>();
  for (const p of pairs) {
    if (!p.agreement || p.winner === "tie") continue;
    for (const c of p.configs) decided.set(c, (decided.get(c) ?? 0) + 1);
    wins.set(p.winner, (wins.get(p.winner) ?? 0) + 1);
  }
  const rates: Record<string, number> = {};
  for (const [c, n] of decided) rates[c] = (wins.get(c) ?? 0) / n;
  return rates;
}

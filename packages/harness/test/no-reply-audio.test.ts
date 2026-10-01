import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PCM_16K,
  PCM_24K,
  type AudioFrame,
  type RealtimeConnectParams,
  type RealtimeProvider,
  type RealtimeSession,
  type TranscriptEvent
} from "@parley/core";
import { runScenarioReliability } from "../src/reliability-runner.js";
import { writeRunRecord } from "../src/run-records.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the fake model does once the caller's audio starts arriving. */
interface Behaviour {
  audio?: boolean;
  /** Transcribed before the turn ends. */
  textInTurn?: string;
  /** Transcribed after `turnComplete`, before the session closes: Gemini's
   * output transcription trails the audio. */
  textAfterTurn?: string;
}

function fakeProvider(behaviour: Behaviour): RealtimeProvider {
  return {
    name: "fake",
    audio: { accepts: [PCM_16K], emits: PCM_24K },
    // No opening trigger: the run is the derail turn alone.
    openingDelivery: "prompt",
    continuesAfterToolResponse: false,
    connect: async (params: RealtimeConnectParams): Promise<RealtimeSession> => {
      const cb = params.callbacks;
      let started = false;
      const model = (text: string): TranscriptEvent => ({ speaker: "model", text, isFinal: false });
      return {
        sendOpeningTrigger: () => {},
        sendAudio: () => {
          if (started) return;
          started = true;
          setTimeout(() => {
            if (behaviour.audio) cb.onAudio({ encoding: PCM_24K, data: Buffer.alloc(480) });
            if (behaviour.textInTurn) cb.onTranscript(model(behaviour.textInTurn));
            cb.onTurnComplete?.();
            if (behaviour.textAfterTurn) {
              setTimeout(() => cb.onTranscript(model(behaviour.textAfterTurn as string)), 5);
            }
          }, 0);
        },
        notifyActivityEnd: () => {},
        sendToolResponse: () => {},
        // Closing takes a moment, as a real socket's does: late deltas land in it.
        close: async () => {
          await sleep(30);
        }
      };
    }
  };
}

async function codesFor(behaviour: Behaviour): Promise<readonly string[]> {
  const frame: AudioFrame = { encoding: PCM_16K, data: Buffer.from([1, 2]) };
  const report = await runScenarioReliability(
    {
      provider: fakeProvider(behaviour),
      model: "m",
      systemInstruction: "s",
      scenarioId: "topic-change",
      mode: "represented",
      runs: 1
    },
    { loadAudio: () => [frame] }
  );
  return report.failures.flatMap((f) => f.codes);
}

describe("no-reply counts the model's audio, not only its transcript", () => {
  it("is not no-reply when audio is sent and its transcription trails turnComplete", async () => {
    expect(
      await codesFor({ audio: true, textAfterTurn: "Let's get back to the booking." })
    ).toEqual([]);
  });

  it("is not no-reply when transcription trails turnComplete, with no audio counted", async () => {
    expect(await codesFor({ textAfterTurn: "Let's get back to the booking." })).toEqual([]);
  });

  it("is not no-reply when audio is sent and transcription is off", async () => {
    expect(await codesFor({ audio: true })).toEqual([]);
  });

  it("is not no-reply when the text arrives inside the turn", async () => {
    expect(await codesFor({ textInTurn: "Let's get back to the booking." })).toEqual([]);
  });

  it("is no-reply when there is neither audio nor text", async () => {
    expect(await codesFor({})).toEqual(["no-reply"]);
  });
});

describe("run record redaction covers encoded forms of a secret", () => {
  // Characters that encode differently: '+', '/', space and '&'.
  const secret = "sk-A+B/C d&e=ÿ";
  it("strips the secret, its URL encoding and its base64", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-redact-"));
    const b64 = Buffer.from(secret).toString("base64");
    expect(encodeURIComponent(secret)).not.toBe(secret);
    writeRunRecord(
      dir,
      {
        command: "scenario",
        scenarioId: "s",
        provider: "gemini",
        model: "m",
        runIndex: 1,
        transcript: `raw ${secret}`,
        trace: [
          {
            type: "transport-diagnostic",
            message: `wss://x?key=${encodeURIComponent(secret)} auth ${b64}`,
            atMs: 1
          }
        ],
        verdict: {}
      },
      [secret]
    );
    const text = readFileSync(join(dir, readdirSync(dir)[0] as string), "utf8");
    for (const form of [secret, encodeURIComponent(secret), b64]) {
      expect(text).not.toContain(form);
    }
    expect(text).toContain("[redacted]");
  });
});

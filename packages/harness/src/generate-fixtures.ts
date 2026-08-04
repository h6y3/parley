import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { pcm16BufferToSamples, resampleLinear, samplesToPcm16Buffer } from "@parley/audio";
import { DERAIL_SCENARIOS } from "./scenarios.js";

const TARGET_RATE = 16000; // Gemini Live input rate
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_SOURCE_RATE = 24000; // Gemini TTS output rate (PCM16)

export interface SynthResult {
  sampleRate: number;
  pcm: Buffer; // PCM16LE
}

export interface GenerateFixturesDeps {
  /** Render one line to PCM16LE audio. Injected so CI never calls live TTS. */
  synthesize: (text: string) => Promise<SynthResult>;
  writeFile?: (path: string, data: Buffer) => void;
}

/** Render each derail scenario's callee line to a 16kHz PCM16 fixture. Skips the
 * `silence` scenario (no spoken line). Returns the paths written. The live TTS
 * client is injected; see fixtures/README.md for the manual generation command. */
export async function generateFixtures(
  params: { outDir: string },
  deps: GenerateFixturesDeps
): Promise<string[]> {
  const writeFile =
    deps.writeFile ??
    ((p: string, d: Buffer) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, d);
    });
  const written: string[] = [];

  for (const scenario of DERAIL_SCENARIOS) {
    if (!scenario.calleeLine) continue; // silence
    const { sampleRate, pcm } = await deps.synthesize(scenario.calleeLine);
    const samples = pcm16BufferToSamples(pcm);
    const resampled =
      sampleRate === TARGET_RATE ? samples : resampleLinear(samples, sampleRate, TARGET_RATE);
    const path = `${params.outDir}/${scenario.id}.pcm`;
    writeFile(path, samplesToPcm16Buffer(resampled));
    written.push(path);
  }

  return written;
}

/** Build the real Gemini TTS `synthesize` function. The API key is read once,
 * by the caller (`main`), and only ever used here to construct the SDK client
 * — never logged, never threaded any further. */
const RATE_LIMIT_WAIT_MS = 40000; // free-tier TTS is a few requests/min; back off and retry
const MAX_RATE_LIMIT_RETRIES = 10;

function makeGeminiSynthesize(apiKey: string): GenerateFixturesDeps["synthesize"] {
  const client = new GoogleGenAI({ apiKey });
  const callOnce = async (text: string): Promise<SynthResult> => {
    const response = await client.models.generateContent({
      model: GEMINI_TTS_MODEL,
      contents: text,
      config: {
        responseModalities: ["AUDIO"],
        // Gemini TTS models reject an AUDIO response without an explicit voice.
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
      }
    });
    const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) {
      throw new Error("Gemini TTS response did not contain inline audio data.");
    }
    return { sampleRate: GEMINI_TTS_SOURCE_RATE, pcm: Buffer.from(data, "base64") };
  };
  return async (text: string): Promise<SynthResult> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callOnce(text);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          console.error(
            `Rate limited (429); waiting ${RATE_LIMIT_WAIT_MS / 1000}s before retrying…`
          );
          await new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
          continue;
        }
        throw error;
      }
    }
  };
}

/** Manual, key-gated regeneration entrypoint (design spec §5) — makes live
 * Gemini TTS calls. Never invoked by tests; see fixtures/README.md. */
async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("fixtures:generate requires the GEMINI_API_KEY environment variable to be set.");
    process.exitCode = 1;
    return;
  }
  const outDir = fileURLToPath(new URL("../fixtures/derail", import.meta.url));
  const written = await generateFixtures({ outDir }, { synthesize: makeGeminiSynthesize(apiKey) });
  console.log(`Wrote ${written.length} fixture(s) to ${outDir}`);
}

// Run only when this file is executed directly (e.g. `node dist/generate-fixtures.js`
// via the `fixtures:generate` script) — not when the test suite imports the named
// exports above, which must stay side-effect-free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

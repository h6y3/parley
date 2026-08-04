import { GoogleGenAI, Modality } from "@google/genai";

export interface TextPreviewTurnResult {
  label: string;
  userText?: string;
  responseText: string;
}

export interface TextPreviewResult {
  turns: TextPreviewTurnResult[];
  fullText: string;
}

type GenAIFactory = (options: { apiKey: string; httpOptions: { apiVersion: string } }) => GoogleGenAI;

const DEFAULT_API_VERSION = "v1beta";
const TURN_IDLE_TIMEOUT_MS = 10000;
const TURN_COMPLETE_SETTLE_MS = 1200;

/**
 * Fast, cheap dev-loop preview: sends `systemInstruction` plus an opening
 * trigger, then each `userTurns` string, over Gemini Live's raw
 * sendRealtimeInput({text}) channel — bypassing @parley/realtime-gemini's
 * RealtimeSession interface entirely, since that interface deliberately has
 * no generic "send a text turn" method (design spec §7.2). Ported from
 * scripts/voicecall-realtime-textprobe.mjs's turn-cursor logic.
 *
 * THIS IS NOT A RELIABILITY-GATE RUN. The real, audio-mode multi-turn runs
 * via runAudioScript() against the real RealtimeProvider are the gate (design
 * spec §10.1, §10.2: audio is not a strict superset of text prompting, and
 * some failure modes are audio-only). Use this only for fast iteration while
 * writing a Brief or a systemInstruction change; always confirm with an
 * audio-mode run before a live call.
 */
export async function runTextPreview(params: {
  apiKey: string;
  systemInstruction: string;
  openingTrigger: string;
  userTurns: readonly string[];
  model?: string;
  apiVersion?: string;
  genAIFactory?: GenAIFactory;
}): Promise<TextPreviewResult> {
  const model = params.model ?? "gemini-3.1-flash-live-preview";
  const apiVersion = params.apiVersion ?? DEFAULT_API_VERSION;
  const genAIFactory: GenAIFactory = params.genAIFactory ?? ((opts) => new GoogleGenAI(opts));
  const ai = genAIFactory({ apiKey: params.apiKey, httpOptions: { apiVersion } });

  const turns: Array<{ label: string; text: string; userText?: string }> = [
    { label: "opening", text: params.openingTrigger },
    ...params.userTurns.map((text, index) => ({ label: `turn-${index + 1}`, text, userText: text }))
  ];

  const results: TextPreviewTurnResult[] = [];
  let fullText = "";

  await new Promise<void>((resolve, reject) => {
    let turnCursor = 0;
    let currentText = "";
    let session: { sendRealtimeInput: (input: { text: string }) => void; close: () => void } | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const armIdle = (ms: number) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(concludeTurn, ms);
    };

    const sendCurrentTurn = () => {
      if (!session) {
        setTimeout(sendCurrentTurn, 15);
        return;
      }
      session.sendRealtimeInput({ text: turns[turnCursor].text });
      armIdle(TURN_IDLE_TIMEOUT_MS);
    };

    const concludeTurn = () => {
      const turn = turns[turnCursor];
      results.push({ label: turn.label, userText: turn.userText, responseText: currentText });
      fullText += "";
      currentText = "";
      turnCursor += 1;
      if (turnCursor < turns.length) {
        sendCurrentTurn();
      } else {
        session?.close();
        resolve();
      }
    };

    ai.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          systemInstruction: params.systemInstruction
        },
        callbacks: {
          onopen: () => {},
          onmessage: (message) => {
            const delta = message.serverContent?.outputTranscription?.text;
            if (delta) {
              currentText += delta;
              fullText += delta;
            }
            if (message.serverContent?.turnComplete) {
              clearTimeout(idleTimer);
              idleTimer = setTimeout(concludeTurn, TURN_COMPLETE_SETTLE_MS);
              return;
            }
            armIdle(TURN_IDLE_TIMEOUT_MS);
          },
          onerror: (event) => {
            const message = event?.error instanceof Error ? event.error.message : "unknown Gemini Live error";
            reject(new Error(message));
          },
          onclose: () => {}
        }
      })
      .then((s) => {
        session = s;
        sendCurrentTurn();
      })
      .catch(reject);
  });

  return { turns: results, fullText };
}

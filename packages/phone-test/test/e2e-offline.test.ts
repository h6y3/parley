/**
 * Offline end to end: one call, both ends real code, no network.
 *
 * Agent side: Parley's own request handler and a real `CallSession`, placed
 * by POST /call and attached through `handleMediaConnection`, with a fake
 * carrier (Twilio's real media-stream framing, no REST) and a fake realtime
 * provider that speaks scripted audio after scripted pauses.
 *
 * Callee side: the real sim handler, with a fake callee provider that answers
 * 300 ms after it hears the caller stop.
 *
 * Between them, an in-process "phone line": two fake Twilio media sockets,
 * each delivering what the other sends as inbound media. Both ends pace their
 * outbound audio at the real telephony rate (the Twilio stream does), so the
 * capture is laid out on the real clock and the timing analysis reads real
 * gaps.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canConvert, convert, createAudioCodec, muLawEncode } from "@parley/audio";
import {
  MULAW_8K,
  type AudioFrame,
  type RealtimeConnectParams,
  type RealtimeProvider,
  type RealtimeSession,
  type TelephonyProvider,
  type WebSocketLike
} from "@parley/core";
import {
  PendingSessions,
  createHostAllowlist,
  createNumberAllowlist,
  handleHttpRequest,
  handleMediaConnection,
  type CompletedCallRecord
} from "@parley/server";
import { attachTwilioMediaStream } from "@parley/telephony-twilio";
import type { Timeline } from "../src/capture.js";
import { scoreCall } from "../src/cli.js";
import { checkOutcome } from "../src/outcome.js";
import { buildEnvelope, loadScenario, type TestConfig } from "../src/scenario.js";
import { CALLEE_ANSWER_CUE, createSimHandler } from "../src/sim-server.js";
import { analyzeTiming, loadThresholds } from "../src/timing.js";

const PUBLIC_HOST = "voice.example.com";
const AUTH_TOKEN = "test-auth-token";
const CALL_TOKEN = "test-call-token";
const CAMPAIGN_NUMBER = "+15555550123";
const AGENT_SID = "CAagent0001";
const SIM_SID = "CAsim0001";
/** The daemon's caller number (its TWILIO_FROM_NUMBER). */
const CALLER = "+15555550199";
const PKG = join(import.meta.dirname, "..");

/** Scripted pauses: the agent's reply gap after each callee line. */
const AGENT_GAPS_MS = [700, 500];
const CALLEE_ANSWER_MS = 300;

// ---------------------------------------------------------------- the line

const SILENT = new Set([0xff, 0x7f]); // μ-law ±0
const voiced = (data: Buffer): boolean => data.some((b) => !SILENT.has(b));
const tone = (ms: number): Buffer => muLawEncode(new Int16Array(8 * ms).fill(8000));

interface End {
  socket: WebSocketLike;
  emit(event: "message" | "close", data?: unknown): void;
  closed: boolean;
}

/** Two Twilio media sockets joined back to back: media one end sends arrives
 * at the other as inbound media; marks are echoed (both ends pace locally, so
 * a mark is sent only once its audio has gone out); either end closing is the
 * call ending, which Twilio reports to the other end as `stop` then a close. */
function phoneLine(): { agent: End; sim: End; start(): void } {
  const make = (streamSid: string): End => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {
      message: [],
      close: [],
      error: []
    };
    const end: End = {
      closed: false,
      emit: (event, data) => listeners[event].forEach((l) => l(data)),
      socket: {
        send: (d) => {
          if (end.closed) return;
          const msg = JSON.parse(typeof d === "string" ? d : d.toString("utf8")) as {
            event: string;
            media?: { payload: string };
            mark?: { name: string };
          };
          if (msg.event === "media" && msg.media) {
            const far = end === line.agent ? line.sim : line.agent;
            if (!far.closed) {
              far.emit(
                "message",
                JSON.stringify({
                  event: "media",
                  streamSid: far === line.agent ? "MZagent" : "MZsim",
                  media: { track: "inbound", payload: msg.media.payload }
                })
              );
            }
          } else if (msg.event === "mark" && msg.mark) {
            const { name } = msg.mark;
            queueMicrotask(() =>
              end.emit("message", JSON.stringify({ event: "mark", mark: { name } }))
            );
          }
        },
        on: (event, listener) => {
          listeners[event].push(listener);
        },
        close: () => {
          if (end.closed) return;
          end.closed = true;
          end.emit("close");
          const far = end === line.agent ? line.sim : line.agent;
          if (!far.closed) {
            far.emit("message", JSON.stringify({ event: "stop", streamSid }));
            far.socket.close();
          }
        }
      }
    };
    return end;
  };
  const line = {
    agent: make("MZagent"),
    sim: make("MZsim"),
    start() {
      line.agent.emit(
        "message",
        JSON.stringify({
          event: "start",
          streamSid: "MZagent",
          start: { streamSid: "MZagent", callSid: AGENT_SID }
        })
      );
      line.sim.emit(
        "message",
        JSON.stringify({
          event: "start",
          streamSid: "MZsim",
          start: { streamSid: "MZsim", callSid: SIM_SID }
        })
      );
    }
  };
  return line;
}

/** Calls `onDone` `pauseMs` after the far end's speech stops. A timer re-armed
 * on every voiced frame: silence frames never re-arm it. */
function listener(onDone: () => void, pauseMs: () => number | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (frame: AudioFrame): void => {
    if (!voiced(frame.data)) return;
    const pause = pauseMs();
    if (pause === undefined) return;
    clearTimeout(timer);
    timer = setTimeout(onDone, pause);
  };
}

function speak(cb: RealtimeConnectParams["callbacks"], ms: number, text: string): void {
  const audio = tone(ms);
  for (let i = 0; i < audio.length; i += 160) {
    cb.onAudio({ encoding: MULAW_8K, data: audio.subarray(i, i + 160) });
  }
  cb.onTranscript({ speaker: "model", text, isFinal: true });
  cb.onTurnComplete?.();
}

function quietSession(over: Partial<RealtimeSession>): RealtimeSession {
  return {
    sendOpeningTrigger: () => {},
    sendAudio: () => {},
    notifyActivityEnd: () => {},
    sendToolResponse: () => {},
    close: async () => {},
    ...over
  };
}

/** The agent's model: hears a callee line, waits its scripted gap, answers.
 * Its second answer records the outcome, says goodbye and ends the call. */
function scriptedAgent(heardLines: string[]): RealtimeProvider & { toolAnswers: string[] } {
  const toolAnswers: string[] = [];
  return {
    name: "fake-agent",
    audio: { accepts: [MULAW_8K], emits: MULAW_8K },
    openingDelivery: "prompt",
    continuesAfterToolResponse: false,
    toolAnswers,
    async connect(params) {
      const cb = params.callbacks;
      let turn = 0;
      const reply = (): void => {
        const i = turn++;
        cb.onTranscript({ speaker: "caller", text: heardLines[i] ?? "", isFinal: true });
        if (i === 0) {
          speak(cb, 800, "Hi Sam, this is Ava, calling for Jordan Rivera to move a cleaning.");
        } else if (i === 1) {
          cb.onToolCall?.({
            id: "t1",
            name: "record_outcome",
            args: {
              status: "completed",
              fields: { newAppointment: "Monday at 10am with Dr. Nguyen", confirmedBy: "Sam" }
            }
          });
          speak(cb, 500, "Thank you, goodbye.");
          cb.onToolCall?.({ id: "t2", name: "end_call", args: { reason: "done" } });
        }
      };
      const hear = listener(reply, () => AGENT_GAPS_MS[turn]);
      return quietSession({
        sendAudio: hear,
        sendToolResponse: (_call, result) => toolAnswers.push(result)
      });
    }
  };
}

/** The sim's callee: answers 300 ms after the answer cue, then 300 ms after
 * the caller stops, one scripted line each time. */
function scriptedCallee(lines: string[]): RealtimeProvider {
  return {
    name: "fake-callee",
    audio: { accepts: [MULAW_8K], emits: MULAW_8K },
    openingDelivery: "turn",
    continuesAfterToolResponse: true,
    async connect(params) {
      const cb = params.callbacks;
      let next = 0;
      const say = (): void => {
        const line = lines[next++];
        if (line !== undefined) speak(cb, 600, line);
      };
      const hear = listener(say, () => (next < lines.length ? CALLEE_ANSWER_MS : undefined));
      return quietSession({
        sendOpeningTrigger: (text) => {
          if (text === CALLEE_ANSWER_CUE) setTimeout(say, CALLEE_ANSWER_MS);
        },
        sendAudio: hear
      });
    }
  };
}

// ---------------------------------------------------------------- helpers

function sign(url: string, body: string): string {
  const params = new URLSearchParams(body);
  const data =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + params.getAll(k).join(""))
      .join("");
  return createHmac("sha1", AUTH_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

async function waitFor<T>(what: string, get: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------- the test

describe("offline end to end: a real CallSession against the real sim", () => {
  it("captures the call, reads the scripted gaps and checks the session's record", async () => {
    const scenario = loadScenario(join(PKG, "scenarios", "dental-reschedule.json"));
    const persona = scenario.personas.find((p) => p.name === "cooperative")!;
    const config: TestConfig = { name: "gemini-default", realtime: { provider: "gemini" } };
    const calleeLines = ["Bayside Dental, this is Sam.", "Okay, you're all set for Monday at 10."];
    const outDir = mkdtempSync(join(tmpdir(), "e2e-"));
    const line = phoneLine();

    // Callee side.
    const sim = createSimHandler({
      publicHost: PUBLIC_HOST,
      authToken: AUTH_TOKEN,
      callerNumber: CALLER,
      callee: { provider: scriptedCallee(calleeLines), model: "fake-callee" },
      outDir
    });
    const control = (method: string, path: string, body?: unknown) =>
      sim.handleHttp({
        method,
        path,
        query: "",
        headers: { "content-type": "application/json" },
        rawBody: body === undefined ? "" : JSON.stringify(body),
        remoteAddress: "127.0.0.1"
      });
    const tag = "dental-reschedule.cooperative.gemini-default.1-e2e";
    expect((await control("POST", "/control/expect", { persona, tag })).status).toBe(200);

    // Agent side: placed through the daemon's own request handler.
    const agentModel = scriptedAgent(calleeLines);
    const pending = new PendingSessions();
    const telephony: TelephonyProvider = {
      name: "fake-twilio",
      mediaEncoding: MULAW_8K,
      originate: async () => ({ providerCallId: AGENT_SID, status: "queued" }),
      buildAnswerResponse: () => ({ contentType: "text/xml", body: "" }),
      verifyWebhookSignature: () => true,
      attachMediaStream: (p) => attachTwilioMediaStream(p),
      // Twilio's REST hangup ends the call, which closes both media streams.
      hangup: async () => line.agent.socket.close()
    };
    const envelope = buildEnvelope(scenario, CAMPAIGN_NUMBER, config);
    const placed = await handleHttpRequest(
      {
        method: "POST",
        path: "/call",
        query: "",
        headers: { authorization: `Bearer ${CALL_TOKEN}`, "content-type": "application/json" },
        rawBody: JSON.stringify(envelope)
      },
      {
        telephony,
        realtime: {
          providers: { gemini: { provider: agentModel, model: "fake-agent" } },
          default: "gemini"
        },
        codec: createAudioCodec(),
        convert,
        canConvert,
        from: CALLER,
        publicHost: PUBLIC_HOST,
        numberAllowlist: createNumberAllowlist([CAMPAIGN_NUMBER]),
        hostAllowlist: createHostAllowlist([PUBLIC_HOST]),
        pending,
        callToken: CALL_TOKEN,
        meetingArtifactsConfigured: false
      }
    );
    expect(placed.status).toBe(202);
    expect(JSON.parse(placed.body)).toEqual({ callId: AGENT_SID });

    // The sim's number rings: Twilio fetches its answer webhook.
    // From is the daemon's caller number: the sim rejects any other caller.
    const form = new URLSearchParams({ CallSid: SIM_SID, From: CALLER }).toString();
    const answered = await sim.handleHttp({
      method: "POST",
      path: "/sim/answer",
      query: "",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sign(`https://${PUBLIC_HOST}/sim/answer`, form)
      },
      rawBody: form,
      remoteAddress: "127.0.0.1"
    });
    expect(answered.status).toBe(200);

    // Both media streams open.
    let record: CompletedCallRecord | undefined;
    sim.handleMedia(SIM_SID, line.sim.socket);
    await handleMediaConnection(AGENT_SID, line.agent.socket, {
      pending,
      onCallCompleted: (r) => {
        record = r;
      }
    });
    line.start();

    const done = await (async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const r = JSON.parse((await control("GET", `/control/result/${tag}`)).body) as {
          state: string;
          wavPath?: string;
          timelinePath?: string;
          error?: string;
        };
        if (r.state === "done") return r;
        if (Date.now() > deadline) throw new Error("sim never finished the call");
        await new Promise((res) => setTimeout(res, 50));
      }
    })();
    const rec = await waitFor("the call record", () => record);

    // A WAV and a timeline were written.
    expect(done.error).toBeUndefined();
    expect(done.wavPath && existsSync(done.wavPath)).toBe(true);
    expect(done.timelinePath && existsSync(done.timelinePath)).toBe(true);
    const wav = readFileSync(done.wavPath!);
    const timeline = JSON.parse(readFileSync(done.timelinePath!, "utf8")) as Timeline;
    expect(timeline.calleeText).toEqual(calleeLines);

    // The timing analysis finds the agent's scripted pauses.
    const thresholds = loadThresholds(join(PKG, "configs", "thresholds.json"));
    const timing = analyzeTiming(wav, timeline, thresholds);
    expect(timing.responseGapsMs).toHaveLength(AGENT_GAPS_MS.length);
    timing.responseGapsMs.forEach((gap, i) => {
      expect(Math.abs(gap - AGENT_GAPS_MS[i]!)).toBeLessThan(200);
    });
    expect(timing.spokeBeforeCallee).toBe(false);
    expect(timing.codes).toEqual([]);

    // The outcome checks run on the session's own record.
    expect(rec.callId).toBe(AGENT_SID);
    expect(rec.endedBy).toBe("model");
    expect(rec.outcome?.status).toBe("completed");
    expect(checkOutcome(rec, scenario.expect, timeline.calleeText)).toEqual([]);

    // And the campaign's per-call scoring composes the two.
    const scored = scoreCall(
      {
        tag,
        scenarioId: scenario.id,
        persona: persona.name,
        config: config.name,
        callId: AGENT_SID,
        wavPath: done.wavPath!,
        timelinePath: done.timelinePath!,
        record: rec,
        minutes: 0.1,
        usd: 0,
        errors: []
      },
      scenario.expect,
      thresholds
    );
    expect(scored.timing?.responseGapsMs).toEqual(timing.responseGapsMs);
    expect(scored.outcomeCodes).toEqual([]);
  }, 30_000);
});

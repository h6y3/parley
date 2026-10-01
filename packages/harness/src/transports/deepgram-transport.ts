import {
  buildDeepgramSettings,
  createDeepgramTurnCompletion,
  DEEPGRAM_AGENT_URL,
  DEFAULT_DEEPGRAM_LISTEN_MODEL,
  DEFAULT_DEEPGRAM_SPEED,
  DEFAULT_DEEPGRAM_VOICE,
  defaultWsFactory,
  type AgentSocket,
  type WsFactory
} from "@parley/realtime-deepgram";
import type { RealtimeSessionCallbacks } from "@parley/core";
import type { ScenarioTransport } from "../scenario-transport.js";

/** Deepgram closes an agent socket that goes quiet and asks for a KeepAlive
 * every 8 s when no audio flows. In text mode no audio ever flows, so this
 * runs for the whole session rather than only covering a stall. */
const KEEPALIVE_INTERVAL_MS = 8000;
const DEFAULT_SETTINGS_TIMEOUT_MS = 10_000;

interface AgentMessage {
  type?: string;
  role?: "user" | "assistant";
  content?: string;
  functions?: { id?: string; name?: string; arguments?: string; client_side?: boolean }[];
  code?: string;
  description?: string;
  message?: string;
}

/** `buildDeepgramSettings` reads none of these; they exist only because
 * `RealtimeConnectParams` requires them. */
const UNUSED_CALLBACKS: RealtimeSessionCallbacks = {
  onAudio: () => {},
  onInterrupted: () => {},
  onTranscript: () => {},
  onError: () => {},
  onClose: () => {}
};

/**
 * Deepgram's Voice Agent as a scenario transport, text only: callee lines as
 * `InjectUserMessage`, the model's words from `ConversationText` with role
 * `assistant`, turn end on `AgentAudioDone` once the agent's audio has then
 * stayed quiet — production's rule, from the same `createDeepgramTurnCompletion`.
 * The agent's audio is otherwise discarded, reported only as the fact that it
 * arrived (`modelAudio`), for ToolGate's completed-record confirmation rule.
 *
 * The `Settings` message is built by `buildDeepgramSettings` — the function
 * production calls — so the two cannot drift. That includes the audio
 * settings, which are irrelevant to a text run but which Deepgram requires.
 *
 * Turn boundaries are the provider's own and are NOT Gemini's. A silent turn
 * does end — Deepgram sends `AgentAudioDone` with zero audio bytes for it,
 * observed on every live probe — but a line injected straight after a tool
 * answer lands on the continuation, which Deepgram cancels, and the line is
 * then folded into one turn with it or left with no reply. Gemini ends each with
 * its own `turnComplete`. So on this transport the runner holds a
 * press-released line until the continuation has ended; see
 * docs/scenario-authoring.md.
 *
 * Never sends `InjectAgentMessage` (spoken verbatim, bypassing the model) or
 * any `Update*` (a mid-session re-instruction).
 *
 * THIS MAKES BILLED DEEPGRAM CALLS. Never run it in CI.
 */
export function deepgramTransport(opts: {
  apiKey: string;
  /** `agent.think` — the model under test. */
  think: { provider: string; model: string };
  wsFactory?: WsFactory;
  /** How long `connect` waits for `SettingsApplied` before rejecting. */
  settingsTimeoutMs?: number;
  /** The quiet window after `AgentAudioDone`. Defaults to production's
   * `DEEPGRAM_TURN_QUIET_MS`, and the CLI never sets it: it exists so an
   * end-to-end test over a fake socket that answers in milliseconds need not
   * spend real seconds waiting out a window sized for a live vendor. */
  turnQuietMs?: number;
}): ScenarioTransport {
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const settingsTimeoutMs = opts.settingsTimeoutMs ?? DEFAULT_SETTINGS_TIMEOUT_MS;
  let socket: AgentSocket | undefined;
  let ready = false;
  /** Set by `close()` and on any close, so the close the runner asked for is
   * not reported back to it as the session dying underneath it. */
  let closed = false;
  /** Whether any assistant utterance has been passed on yet — see
   * `ConversationText` below. */
  let spokenBefore = false;
  /** Set when a callee line is injected, cleared when Deepgram echoes it back
   * (`ConversationText` user role, then `EndOfTurn`). An `AgentAudioDone` in
   * that window ends the turn the line interrupted, not a reply to it — see
   * `AgentAudioDone` below. */
  let lineInFlight = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  /** Production's turn-end rule (`createDeepgramRealtimeProvider`), shared
   * rather than restated: an `AgentAudioDone` can be followed by more of the
   * same reply, so the turn ends only once the audio has stayed quiet for
   * DEEPGRAM_TURN_QUIET_MS. A harness that ended turns earlier than
   * production would score a boundary no live call has. */
  let turnEnd: ReturnType<typeof createDeepgramTurnCompletion> | undefined;

  const send = (message: Record<string, unknown>): void => {
    if (!ready || closed) return;
    socket?.send(JSON.stringify(message));
  };

  return {
    // Not because a silent continuation ends no turn — it does, with a
    // zero-audio `AgentAudioDone`. Because a line injected straight after the
    // tool answer lands on that continuation, and Deepgram cancels it (the
    // call reads `{"status":"CANCELLED"}` in the model's history) and then
    // either folds the line into one turn with ONE `AgentAudioDone` or the
    // line gets no reply at all, the turn closing with a zero-audio one (4 of
    // 8 billed DG+gpt sessions). So the runner never injects on top of a
    // continuation here; a press-released line waits for its turn end. Not a
    // claim that Deepgram stops after a tool answer: it continues, which is
    // why the production provider declares `continuesAfterToolResponse: true`.
    completesAfterToolResponse: false,
    // As `createDeepgramRealtimeProvider` declares: `InjectUserMessage` is
    // heard as the callee, so the opening rides in the Settings prompt and a
    // two-party run injects nothing before the first callee line.
    openingDelivery: "prompt",
    connect({ systemInstruction, tools, on }) {
      return new Promise<void>((resolve, reject) => {
        let s: AgentSocket;
        try {
          // The key travels in a header and never in the URL.
          s = wsFactory(DEEPGRAM_AGENT_URL, { Authorization: `Token ${opts.apiKey}` });
        } catch {
          // Not re-raised: the underlying error may quote the request, and the
          // request carries the credential.
          reject(new Error("deepgram: could not open agent socket"));
          return;
        }
        socket = s;
        turnEnd = createDeepgramTurnCompletion(() => {
          if (!closed) on.turnComplete();
        }, opts.turnQuietMs);
        const settings = buildDeepgramSettings(
          {
            model: opts.think.model,
            systemInstruction,
            responseModality: "audio",
            tools,
            callbacks: UNUSED_CALLBACKS
          },
          {
            think: opts.think,
            listenModel: DEFAULT_DEEPGRAM_LISTEN_MODEL,
            voice: DEFAULT_DEEPGRAM_VOICE,
            // The shared constant, so harness pace cannot drift from production's default.
            speed: DEFAULT_DEEPGRAM_SPEED
          }
        );

        let pending = true;
        const timeout = setTimeout(() => {
          failHandshake(new Error("deepgram: no SettingsApplied within the settings timeout"));
        }, settingsTimeoutMs);
        function failHandshake(err: Error): void {
          if (!pending) return;
          pending = false;
          clearTimeout(timeout);
          closed = true;
          s.close();
          reject(err);
        }

        s.on("open", (() => {
          s.send(JSON.stringify(settings));
        }) as never);

        s.on("error", (() => {
          // After ready, the close that follows is what ends the session.
          if (pending) failHandshake(new Error("deepgram: agent socket failed to open"));
        }) as never);

        s.on("message", ((raw: Buffer, isBinary: boolean) => {
          // The agent's speech. A text run reads its words, not its audio —
          // but the audio still says whether the turn is still speaking.
          if (isBinary) {
            turnEnd?.audio();
            on.modelAudio?.();
            return;
          }
          let msg: AgentMessage;
          try {
            msg = JSON.parse(raw.toString()) as AgentMessage;
          } catch {
            return;
          }
          switch (msg.type) {
            case "SettingsApplied":
              if (!pending) return;
              pending = false;
              clearTimeout(timeout);
              ready = true;
              keepAlive = setInterval(() => send({ type: "KeepAlive" }), KEEPALIVE_INTERVAL_MS);
              keepAlive.unref?.();
              resolve();
              return;
            case "Error": {
              const message = `${msg.code ?? "unknown"}: ${msg.description ?? "no description"}`;
              if (pending)
                failHandshake(new Error(`deepgram: agent refused settings (${message})`));
              // After ready Deepgram keeps the socket open; a close is what
              // ends a session, so this is only worth a trace line.
              else on.diagnostic?.(`deepgram Error ${message}`);
              return;
            }
            case "InjectionRefused":
              // The line was never heard, but the runner has already counted
              // it: advanced its cursor, recorded it as heard, anchored
              // consent on it. Carrying on would score the model on a line it
              // never received, and a retry would be the harness advancing the
              // script on its own. So the run ends here, through the same
              // path as a dead session — a scored non-model outcome.
              if (closed) return;
              closed = true;
              clearInterval(keepAlive);
              turnEnd?.cancel();
              on.closed(`InjectionRefused: ${msg.message ?? "no reason"}`);
              return;
            case "EndOfTurn":
              lineInFlight = false;
              return;
            case "ConversationText":
              // The user role is Deepgram echoing our own injected line back.
              if (msg.role === "user") lineInFlight = false;
              if (msg.role !== "assistant" || !msg.content) return;
              // Each event is a whole utterance with no trailing space, and the
              // runner joins what it is given as-is — right for Gemini's
              // deltas, wrong here: "It's 160" then "8am works" would read
              // "1608am", and the amount checks read digits.
              on.modelText(spokenBefore ? ` ${msg.content}` : msg.content);
              spokenBefore = true;
              return;
            case "AgentAudioDone":
              // A line injected while agent audio still streams is a barge-in:
              // Deepgram sends `UserStartedSpeaking`, ends the interrupted turn
              // with this, and only then echoes the line. Passed on, it reads
              // as the reply to the line, and the runner sends the next line
              // on top of the real reply — which barges in again, one turn
              // ahead of the model for the rest of the run (seen in billed
              // wire logs). The reply's own `AgentAudioDone` follows the echo.
              if (lineInFlight) {
                on.diagnostic?.("deepgram AgentAudioDone of a turn a callee line interrupted");
                return;
              }
              // Not yet the turn end: more of this reply's audio may follow.
              turnEnd?.audioDone();
              return;
            case "FunctionCallRequest":
              for (const fc of msg.functions ?? []) {
                // A server-side function is Deepgram's to answer.
                if (fc.client_side === false) continue;
                if (!fc.id || !fc.name) continue;
                let args: Record<string, unknown> = {};
                if (fc.arguments) {
                  try {
                    args = JSON.parse(fc.arguments) as Record<string, unknown>;
                  } catch {
                    // Malformed: treat as none, so ToolGate's own validation
                    // is what refuses the call — as production does.
                  }
                }
                on.toolCall({ id: fc.id, name: fc.name, args });
              }
              return;
            default:
              return;
          }
        }) as never);

        s.on("close", ((code: number, reason: Buffer) => {
          clearInterval(keepAlive);
          turnEnd?.cancel();
          if (pending) {
            failHandshake(new Error("deepgram: agent socket closed before SettingsApplied"));
            return;
          }
          ready = false;
          if (closed) return;
          closed = true;
          on.closed(
            `deepgram agent closed: code=${code ?? "unknown"} reason=${reason?.toString().trim() || "none"}`
          );
        }) as never);
      });
    },
    sendCalleeText(text) {
      // A USER turn the model answers — the same message production sends
      // its one opening line as (a meeting's `MEETING_CONNECTED_CUE`).
      if (ready && !closed) {
        lineInFlight = true;
        // A turn end still settling belongs to the turn this line lands on —
        // the same case as an `AgentAudioDone` arriving while the line is in
        // flight. Passed on after the line, it would read as the reply to it.
        turnEnd?.cancel();
      }
      send({ type: "InjectUserMessage", content: text });
    },
    sendToolResponse(call, result) {
      // `content` is the closed ToolResult union, as-is.
      send({ type: "FunctionCallResponse", id: call.id, name: call.name, content: result });
    },
    async close() {
      closed = true;
      clearInterval(keepAlive);
      turnEnd?.cancel();
      socket?.close();
    }
  };
}

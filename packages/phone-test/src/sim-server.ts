import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { canConvert, convert, muLawDecodeSample } from "@parley/audio";
import {
  AudioBridge,
  MULAW_8K,
  type AudioFrame,
  formatEncoding,
  type MediaStreamHandle,
  type RealtimeProvider,
  type RealtimeSession,
  type ToolCallRequest,
  type ToolDeclaration,
  type ToolName,
  type WebSocketLike
} from "@parley/core";
import { wrapWsSocket } from "@parley/server";
import {
  attachTwilioMediaStream,
  buildStreamTwiml,
  verifyTwilioSignature
} from "@parley/telephony-twilio";
import { CaptureRecorder } from "./capture.js";
import { parsePersona, personaPrompt, type CalleePersona } from "./scenario.js";

/** The port `parley sim serve` listens on. */
export const SIM_PORT = 3340;

// Twilio's form webhooks and the control API's JSON are both tiny. Capping
// buffering before authentication keeps an unauthenticated sender from
// exhausting memory, as the daemon does.
const MAX_BODY_BYTES = 64 * 1024;

const REJECT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';

/** The sim's own ceiling on one call, from answer: the 300 s per-call ceiling
 * plus a margin. It holds even if the runner has died and the daemon's own
 * limit did not fire, so a bot-to-bot loop cannot run up unbooked minutes. */
export const SIM_MAX_CALL_MS = 330_000;

/** How long a goodbye may take to finish playing before the stream closes. */
const HANGUP_DRAIN_MS = 5_000;

/** The persona a call gets when the runner registered none: the sim cannot
 * know what the call is for, so it says so and ends it. */
export const WRONG_NUMBER_PERSONA: CalleePersona = Object.freeze({
  name: "wrong-number",
  role: "someone who answered their own phone and is not expecting any call",
  facts: [],
  behaviours: ['Answer with "Hello?"', 'Whatever the caller says, reply "Sorry, wrong number."'],
  endsCallWith: "Sorry, wrong number."
}) as CalleePersona;

/** The callee answered the phone, so it speaks first. A short fixed line, sent
 * once at connect through the session's opening input. */
export const CALLEE_ANSWER_CUE = "Your phone is ringing. Answer it now.";

/** How long the callee waits after the line opens before it speaks. A person
 * picks up, brings the phone to their ear and then says hello; an agent that
 * cannot hear a greeting arriving the instant the stream opens would never be
 * caught by a callee that never pauses. */
export const CALLEE_PICKUP_PAUSE_MS = 1200;

/** Mutual silence after the callee's hello, before it says "Hello?" again. */
export const CALLEE_REPROMPT_SILENCE_MS = 3000;

/** How many times the callee says "Hello?" again before it simply waits. */
export const CALLEE_MAX_REPROMPTS = 2;

/** The cue that makes the callee bot say "Hello?" again. Fixed text through
 * the session's one-line opening input, as the keypad cue is. */
export const CALLEE_REPROMPT_CUE = "[silence on the line — say 'Hello?' again]";

/** An agent frame at or above this RMS level (dBFS) is the agent's voice;
 * below it is line silence. */
const AGENT_VOICE_DBFS = -40;
/** A contiguous run of voiced agent audio this long is the agent speaking.
 * Shorter bursts (clicks, a blip of line noise) are ignored entirely: they
 * neither restart the silence window nor stop the callee saying hello again. */
const AGENT_SPOKE_MS = 100;

/** μ-law 8 kHz carries 8 samples per millisecond. */
const MULAW_SAMPLES_PER_MS = 8;

function voiced(mulaw: Buffer): boolean {
  if (mulaw.length === 0) return false;
  let sum = 0;
  for (const byte of mulaw) {
    const v = muLawDecodeSample(byte);
    sum += v * v;
  }
  const rms = Math.sqrt(sum / mulaw.length);
  return rms > 0 && 20 * Math.log10(rms / 32768) >= AGENT_VOICE_DBFS;
}

const HANG_UP_INSTRUCTION =
  "When you have said goodbye, call the hang_up tool to end the call. " +
  "Never call it before you have said goodbye.";

/** The callee bot's one tool. `ToolName` is the closed set of Parley's own
 * agent tools; providers pass the name through untouched, and the callee bot
 * is not a Parley agent, so its name sits outside that set by design. */
const HANG_UP_TOOL: ToolDeclaration = {
  name: "hang_up" as string as ToolName,
  description: "End the phone call. Call it only after you have said goodbye.",
  parametersJsonSchema: { type: "object", properties: {} }
};

// A tag names the capture files, so it is confined to a plain file name.
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A CallSid becomes part of a URL path and, for an unregistered call, a tag.
const CALL_SID = /^[A-Za-z0-9]{1,64}$/;
const KEYPAD_DIGIT = /^[0-9*#]$/;
const MEDIA_PATH = /^\/sim\/media\/([A-Za-z0-9]{1,64})$/;
const TERMINAL_CALL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// A tunnel or proxy delivers from loopback as well; these headers are how its
// requests differ from a local process's.
const FORWARDING_HEADERS = ["x-forwarded-for", "cf-connecting-ip", "forwarded", "x-real-ip"];

export interface SimServerOptions {
  port: number;
  /** The public hostname Twilio calls (e.g. `voice.example.com`). Webhook
   * signatures are verified against `https://<publicHost><path>`, whatever
   * host the request arrived on. */
  publicHost: string;
  /** The Twilio auth token webhook signatures are made with. */
  authToken: string;
  /** The daemon's caller number (its `TWILIO_FROM_NUMBER`, E.164). Any call
   * from another number is rejected before it can take a queued persona: a
   * newly bought number draws stray calls, and each one answered is billed. */
  callerNumber: string;
  /** The provider that plays the callee: whichever one is not under test. */
  callee: { provider: RealtimeProvider; model: string; voice?: string };
  /** Where `<tag>.wav` and `<tag>.timeline.json` are written. */
  outDir: string;
  /** Monotonic milliseconds for the capture clock. */
  now?: () => number;
  /** Each call's ceiling from answer (default `SIM_MAX_CALL_MS`). */
  maxCallMs?: number;
  /** The pause before a realistic callee answers (default
   * `CALLEE_PICKUP_PAUSE_MS`). */
  pickupPauseMs?: number;
}

export type SimHandlerOptions = Omit<SimServerOptions, "port">;

export interface SimHttpRequest {
  method: string;
  path: string;
  query: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  rawBody: string;
  remoteAddress: string | undefined;
}

export interface SimHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface SimResult {
  state: "pending" | "done";
  wavPath?: string;
  timelinePath?: string;
  callSid?: string;
  error?: string;
}

export interface SimHandler {
  handleHttp(req: SimHttpRequest): Promise<SimHttpResponse>;
  /** A Twilio media stream opened for `callSid`. */
  handleMedia(callSid: string, socket: WebSocketLike): void;
  /** End every live call, writing what was captured. */
  stopAll(): Promise<void>;
}

interface SimCall {
  tag: string;
  callSid: string;
  persona: CalleePersona;
  personaMissing: boolean;
  streaming: boolean;
  finished: boolean;
  hangingUp: boolean;
  recorder?: CaptureRecorder;
  handle?: MediaStreamHandle;
  session?: RealtimeSession;
  /** Sends one agent frame to the callee bot, once its session is up. */
  forward?: (frame: AudioFrame) => void;
  /** The model's transcript for the utterance in progress. */
  said: string;
  error?: string;
  /** Ends the call at the sim's ceiling; cleared when it ends first. */
  ceiling?: ReturnType<typeof setTimeout>;
  /** When the media stream opened (the `now` clock). */
  streamStartedAt: number;
  /** Sends the callee's opening at the end of the pickup pause. */
  pickup?: ReturnType<typeof setTimeout>;
  /** Fires when mutual silence has lasted `CALLEE_REPROMPT_SILENCE_MS`. */
  repromptTimer?: ReturnType<typeof setTimeout>;
  /** The callee bot has produced audio on this call. */
  calleeSpoke: boolean;
  /** When the callee audio sent so far finishes playing (the `now` clock). */
  calleePlayoutEnd: number;
  /** The current contiguous run of voiced agent frames, in ms. */
  agentVoicedRunMs: number;
  /** The agent has spoken: the callee never says "Hello?" again after that. */
  agentSpoke: boolean;
  reprompts: number;
  lastRepromptAt: number;
}

const json = (status: number, value: unknown): SimHttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value)
});
const text = (status: number, body: string): SimHttpResponse => ({
  status,
  headers: { "content-type": "text/plain" },
  body
});

const defaultNow = (): number => performance.timeOrigin + performance.now();

/** The sim's request and media handling, without a listening socket. */
export function createSimHandler(opts: SimHandlerOptions): SimHandler {
  const now = opts.now ?? defaultNow;
  const maxCallMs = opts.maxCallMs ?? SIM_MAX_CALL_MS;
  const pickupPauseMs = opts.pickupPauseMs ?? CALLEE_PICKUP_PAUSE_MS;
  const { provider } = opts.callee;
  const queue: { tag: string; persona: CalleePersona }[] = [];
  const results = new Map<string, SimResult>();
  const calls = new Map<string, SimCall>();
  /** Tags of calls answered with no persona queued, oldest first. The runner
   * correlates by tag, never by CallSid (the sim sees the inbound leg's), so
   * this list is how it learns a call it dialled was answered without one. */
  const unclaimed: string[] = [];

  // Refuse an unbridgeable provider now, not on the first frame of a call.
  const toProvider = provider.audio.accepts[0];
  if (!toProvider || !canConvert(MULAW_8K, toProvider)) {
    throw new Error(`sim: cannot convert mulaw@8000 to what ${provider.name} accepts`);
  }
  if (!canConvert(provider.audio.emits, MULAW_8K)) {
    throw new Error(
      `sim: cannot convert ${formatEncoding(provider.audio.emits)} from ${provider.name} to mulaw@8000`
    );
  }

  /** Mirrors the daemon's check: the signed URL is rebuilt from configuration,
   * never from the request's Host header, so a request that reaches
   * 127.0.0.1:3340 through a tunnel verifies against the public URL Twilio
   * actually signed. */
  function verified(req: SimHttpRequest): boolean {
    const fullUrl = `https://${opts.publicHost}${req.path}${req.query ? `?${req.query}` : ""}`;
    return verifyTwilioSignature(
      opts.authToken,
      fullUrl,
      req.rawBody,
      req.headers["x-twilio-signature"]
    );
  }

  function fromLoopback(req: SimHttpRequest): boolean {
    if (!req.remoteAddress || !LOOPBACK.has(req.remoteAddress)) return false;
    return FORWARDING_HEADERS.every((h) => req.headers[h] === undefined);
  }

  function fail(call: SimCall, message: string): void {
    call.error ??= message;
  }

  function flushSaid(call: SimCall): void {
    const line = call.said.trim();
    call.said = "";
    if (line) call.recorder?.calleeSaid(line);
  }

  function finish(call: SimCall): void {
    if (call.finished) return;
    call.finished = true;
    if (call.ceiling) clearTimeout(call.ceiling);
    if (call.pickup) clearTimeout(call.pickup);
    if (call.repromptTimer) clearTimeout(call.repromptTimer);
    const result: SimResult = { state: "done", callSid: call.callSid };
    if (call.recorder) {
      flushSaid(call);
      call.recorder.mark("callee-hangup");
      const { wav, timeline } = call.recorder.finish();
      const wavPath = join(opts.outDir, `${call.tag}.wav`);
      const timelinePath = join(opts.outDir, `${call.tag}.timeline.json`);
      try {
        mkdirSync(opts.outDir, { recursive: true });
        writeFileSync(wavPath, wav);
        writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
        result.wavPath = wavPath;
        result.timelinePath = timelinePath;
      } catch (err) {
        fail(call, `could not write capture: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      fail(call, "no media stream opened");
    }
    if (call.error) result.error = call.error;
    results.set(call.tag, result);
    call.session?.close().catch(() => {});
    try {
      call.handle?.close();
    } catch {
      /* already closed */
    }
  }

  function endStream(call: SimCall): void {
    try {
      call.handle?.close();
    } catch {
      /* already closed */
    }
    finish(call);
  }

  /** (Re)starts the wait for mutual silence. The callee says "Hello?" again
   * only while it has spoken, the agent has not, and reprompts remain. */
  function armReprompt(call: SimCall): void {
    if (call.repromptTimer) clearTimeout(call.repromptTimer);
    call.repromptTimer = undefined;
    if (
      call.finished ||
      call.hangingUp ||
      call.persona.answerStyle === "instant" ||
      call.agentSpoke ||
      !call.calleeSpoke ||
      call.reprompts >= CALLEE_MAX_REPROMPTS
    ) {
      return;
    }
    const quietSince = Math.max(call.calleePlayoutEnd, call.lastRepromptAt);
    const delay = Math.max(0, quietSince + CALLEE_REPROMPT_SILENCE_MS - now());
    call.repromptTimer = setTimeout(() => {
      call.repromptTimer = undefined;
      reprompt(call);
    }, delay);
    call.repromptTimer.unref?.();
  }

  function reprompt(call: SimCall): void {
    if (call.finished || call.hangingUp || call.agentSpoke) return;
    if (call.reprompts >= CALLEE_MAX_REPROMPTS) return;
    call.reprompts += 1;
    call.lastRepromptAt = now();
    call.recorder?.mark("callee-reprompt");
    try {
      call.session?.sendOpeningTrigger(CALLEE_REPROMPT_CUE);
    } catch (err) {
      // A session that cannot take the cue will not take the next one either.
      fail(call, `callee reprompt: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // If the bot stays quiet too, the silence goes on and the next one follows.
    armReprompt(call);
  }

  async function hangUp(call: SimCall, tool: ToolCallRequest): Promise<void> {
    if (call.hangingUp || call.finished) return;
    call.hangingUp = true;
    call.recorder?.mark("callee-goodbye");
    call.session?.sendToolResponse(tool, "ok — say nothing more");
    // Let the goodbye already queued reach the caller before the line drops.
    await call.handle?.drainOutbound(HANGUP_DRAIN_MS).catch(() => undefined);
    endStream(call);
  }

  async function connectCallee(call: SimCall): Promise<void> {
    const toModel = new AudioBridge(provider.audio.accepts, convert);
    const toCarrier = new AudioBridge([MULAW_8K], convert);
    const session = await provider.connect({
      model: opts.callee.model,
      ...(opts.callee.voice ? { voice: opts.callee.voice } : {}),
      systemInstruction: `${personaPrompt(call.persona)}\n\n${HANG_UP_INSTRUCTION}`,
      responseModality: "audio",
      tools: [HANG_UP_TOOL],
      callbacks: {
        onAudio: (frame) => {
          if (call.finished) return;
          const out = toCarrier.adapt(frame);
          call.recorder?.callee(out.data);
          call.handle?.sendOutboundAudio(out);
          // The audio arrives faster than it plays: the line is not quiet
          // until the caller has heard all of it.
          call.calleeSpoke = true;
          call.calleePlayoutEnd =
            Math.max(call.calleePlayoutEnd, now()) + out.data.length / MULAW_SAMPLES_PER_MS;
          armReprompt(call);
        },
        onInterrupted: () => {
          if (call.finished) return;
          call.handle?.clearOutboundBuffer();
          call.recorder?.clearCallee();
          call.recorder?.mark("callee-interrupted");
          call.calleePlayoutEnd = now();
          armReprompt(call);
        },
        onTranscript: (event) => {
          if (event.speaker !== "model") return;
          call.said += event.text;
          if (event.isFinal) flushSaid(call);
        },
        onToolCall: (tool) => {
          if (tool.name === HANG_UP_TOOL.name) {
            void hangUp(call, tool);
          } else {
            call.session?.sendToolResponse(tool, "refused: tool not available");
          }
        },
        onError: (error) => {
          if (!error.fatal) return;
          fail(call, `callee ${error.code}: ${error.message}`);
          endStream(call);
        },
        onClose: (reason) => {
          if (call.finished || call.hangingUp) return;
          fail(call, `callee session closed: ${reason}`);
          endStream(call);
        }
      }
    });
    call.session = session;
    if (call.finished) {
      await session.close().catch(() => {});
      return;
    }
    // A realistic callee picks up, pauses, then speaks; an instant one speaks
    // the moment the line opens.
    const pause =
      call.persona.answerStyle === "instant"
        ? 0
        : Math.max(0, call.streamStartedAt + pickupPauseMs - now());
    if (pause === 0) {
      session.sendOpeningTrigger(CALLEE_ANSWER_CUE);
    } else {
      call.pickup = setTimeout(() => {
        call.pickup = undefined;
        if (call.finished) return;
        try {
          session.sendOpeningTrigger(CALLEE_ANSWER_CUE);
        } catch (err) {
          fail(call, `callee answer: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, pause);
      call.pickup.unref?.();
    }
    // Inbound audio is forwarded only once the session exists; frames before
    // that were the agent listening to a phone that had not been answered yet.
    call.forward = (frame) => session.sendAudio(toModel.adapt(frame));
  }

  function handleMedia(callSid: string, socket: WebSocketLike): void {
    const call = calls.get(callSid);
    if (!call || call.streaming || call.finished) {
      socket.close();
      return;
    }
    call.streaming = true;
    call.streamStartedAt = now();
    const recorder = new CaptureRecorder(now);
    call.recorder = recorder;
    if (call.personaMissing) recorder.mark("persona-missing");
    call.handle = attachTwilioMediaStream({
      callId: callSid,
      socket,
      onInboundAudio: (frame) => {
        if (call.finished) return;
        recorder.agent(frame.data);
        if (!call.agentSpoke) {
          if (voiced(frame.data)) {
            call.agentVoicedRunMs += frame.data.length / MULAW_SAMPLES_PER_MS;
            if (call.agentVoicedRunMs >= AGENT_SPOKE_MS) {
              call.agentSpoke = true;
              armReprompt(call); // cancels: the agent has answered
            }
          } else {
            call.agentVoicedRunMs = 0;
          }
        }
        try {
          call.forward?.(frame);
        } catch (err) {
          fail(call, `callee audio: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      onCallEvent: (event) => {
        if (event.type === "completed" || event.type === "removed") finish(call);
      },
      onDtmf: (digit) => {
        if (call.finished || !KEYPAD_DIGIT.test(digit)) return;
        recorder.mark(`dtmf:${digit}`);
        // A simulated phone menu cannot hear tones in its audio, so the
        // keypress reaches it as a short fixed line. It goes through the
        // session's one-line opening input on purpose: the digit comes from a
        // closed set and the template is fixed, so this stays a cue and never
        // becomes a way to re-instruct the bot.
        try {
          call.session?.sendOpeningTrigger(`[the caller pressed ${digit}]`);
        } catch (err) {
          fail(call, `callee dtmf: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    connectCallee(call).catch((err: unknown) => {
      fail(call, `callee connect failed: ${err instanceof Error ? err.message : String(err)}`);
      endStream(call);
    });
  }

  function answer(req: SimHttpRequest): SimHttpResponse {
    if (!verified(req)) return text(403, "bad signature");
    const form = new URLSearchParams(req.rawBody);
    const callSid = form.get("CallSid") ?? "";
    if (!CALL_SID.test(callSid)) return text(400, "bad CallSid");
    // Only the daemon's calls are answered. <Reject/> ends a stray call
    // unanswered (no media, no callee model), and it never touches the queue.
    if (form.get("From") !== opts.callerNumber) {
      return { status: 200, headers: { "content-type": "text/xml" }, body: REJECT_TWIML };
    }
    // Twilio retries a webhook that timed out; a retry must not take a second persona.
    if (!calls.has(callSid)) {
      const next = queue.shift();
      const tag = next?.tag ?? `persona-missing-${callSid}`;
      const call: SimCall = {
        tag,
        callSid,
        persona: next?.persona ?? WRONG_NUMBER_PERSONA,
        personaMissing: next === undefined,
        streaming: false,
        finished: false,
        hangingUp: false,
        said: "",
        streamStartedAt: 0,
        calleeSpoke: false,
        calleePlayoutEnd: 0,
        agentVoicedRunMs: 0,
        agentSpoke: false,
        reprompts: 0,
        lastRepromptAt: 0
      };
      call.ceiling = setTimeout(() => {
        if (call.finished) return;
        call.recorder?.mark("sim-timeout");
        fail(call, `call ran past the sim's ${Math.round(maxCallMs / 1000)} s ceiling`);
        endStream(call);
      }, maxCallMs);
      call.ceiling.unref?.();
      calls.set(callSid, call);
      results.set(tag, { state: "pending", callSid });
      if (next === undefined) unclaimed.push(tag);
    }
    return {
      status: 200,
      headers: { "content-type": "text/xml" },
      body: buildStreamTwiml(`wss://${opts.publicHost}/sim/media/${callSid}`)
    };
  }

  function status(req: SimHttpRequest): SimHttpResponse {
    if (!verified(req)) return text(403, "bad signature");
    const params = new URLSearchParams(req.rawBody);
    const call = calls.get(params.get("CallSid") ?? "");
    if (call && TERMINAL_CALL_STATUSES.has(params.get("CallStatus") ?? "")) finish(call);
    return { status: 204, headers: {}, body: "" };
  }

  function expectPersona(req: SimHttpRequest): SimHttpResponse {
    let body: { persona?: unknown; tag?: unknown };
    try {
      body = JSON.parse(req.rawBody) as typeof body;
    } catch {
      return json(400, { error: "body is not JSON" });
    }
    const tag = body?.tag;
    if (typeof tag !== "string" || !TAG.test(tag)) {
      return json(400, { error: "tag must be a plain file name: letters, digits, . _ -" });
    }
    let persona: CalleePersona;
    try {
      persona = parsePersona(body.persona);
    } catch (err) {
      return json(400, { error: `invalid persona: ${err instanceof Error ? err.message : ""}` });
    }
    if (results.has(tag) || queue.some((q) => q.tag === tag)) {
      return json(409, { error: `tag "${tag}" is already in use` });
    }
    queue.push({ tag, persona });
    results.set(tag, { state: "pending" });
    return json(200, { queued: queue.length });
  }

  function hangupTag(tag: string): SimHttpResponse {
    const call = [...calls.values()].find((c) => c.tag === tag && !c.finished);
    if (!call) return json(404, { error: "no live call with that tag" });
    call.recorder?.mark("runner-hangup");
    endStream(call);
    return json(200, { ok: true });
  }

  async function handleHttp(req: SimHttpRequest): Promise<SimHttpResponse> {
    const { method, path } = req;
    if (path.startsWith("/control/")) {
      if (!fromLoopback(req)) return text(403, "forbidden");
      if (method === "POST" && path === "/control/expect") return expectPersona(req);
      // The pid lets `campaign stop` confirm a pid file still names this sim
      // before signalling it. Loopback only: the public route says nothing
      // about the host's processes.
      if (method === "GET" && path === "/control/health") {
        return json(200, { ok: true, pid: process.pid });
      }
      if (method === "GET" && path === "/control/unclaimed") {
        return json(200, { tags: [...unclaimed] });
      }
      // Tags are checked raw, never decoded: a valid tag has no characters
      // that need escaping, so a segment that fails TAG names no tag.
      const result = /^\/control\/result\/([^/]+)$/.exec(path);
      if (method === "GET" && result) {
        const r = TAG.test(result[1]) ? results.get(result[1]) : undefined;
        return r ? json(200, r) : json(404, { error: "unknown tag" });
      }
      const hangup = /^\/control\/hangup\/([^/]+)$/.exec(path);
      if (method === "POST" && hangup) {
        if (!TAG.test(hangup[1])) return json(404, { error: "no live call with that tag" });
        return hangupTag(hangup[1]);
      }
      return text(404, "not found");
    }
    if (method === "GET" && path === "/sim/healthz") return json(200, { ok: true });
    if (method === "POST" && path === "/sim/answer") return answer(req);
    if (method === "POST" && path === "/sim/status") return status(req);
    return text(404, "not found");
  }

  return {
    handleHttp,
    handleMedia,
    async stopAll() {
      for (const call of calls.values()) {
        if (call.finished) continue;
        if (call.streaming) endStream(call);
      }
    }
  };
}

/** The simulated callee: Twilio's webhook and media stream on `/sim/*`, and
 * the runner's control API on `/control/*` (loopback only). Binds 127.0.0.1;
 * a tunnel or proxy routes `/sim/*` to it from the public internet. */
export function createSimServer(opts: SimServerOptions): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const handler = createSimHandler(opts);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      if (rejected) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        res.writeHead(413);
        res.end("payload too large");
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      // Reachable without authentication: a target the parser rejects (`//`,
      // an empty authority) must answer 400, never throw out of the listener.
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://sim.invalid");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad request target");
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
      }
      handler
        .handleHttp({
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.search.replace(/^\?/, ""),
          headers,
          rawBody: Buffer.concat(chunks).toString("utf8"),
          remoteAddress: req.socket.remoteAddress
        })
        .then((r) => {
          res.writeHead(r.status, r.headers);
          res.end(r.body);
        })
        .catch(() => {
          try {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "internal error" }));
          } catch {
            /* headers already sent */
          }
        });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  // Reachable from the public internet without authentication, so nothing in
  // here may throw out of the listener: an uncaught throw ends the process.
  server.on("upgrade", (req, socket, head) => {
    const refuse = (): void => {
      try {
        if (socket.writable) socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      } catch {
        /* already gone */
      }
      socket.destroy();
    };
    try {
      // The raw segment, never decoded: a CallSid has no characters that need
      // escaping, so anything else is not one.
      const path = (req.url ?? "/").split("?")[0];
      const match = MEDIA_PATH.exec(path);
      if (!match) return refuse();
      const callSid = match[1];
      wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
        try {
          handler.handleMedia(callSid, wrapWsSocket(ws));
        } catch {
          ws.terminate();
        }
      });
    } catch {
      refuse();
    }
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
    async stop() {
      await handler.stopAll();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

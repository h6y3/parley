// examples/express-minimal/server.mjs — embedding @parley/core + @parley/policy
// plus providers directly in a small Express app, WITHOUT the standalone
// @parley/server daemon (design spec §6). Express is this example consumer's
// choice; it is independent of @parley/server's own node:http stack.
// Demonstrates library (not daemon) use.
//
// This is illustrative wiring — see @parley/server for the production daemon.
import express from "express";
import { CallSession } from "@parley/core";
import { composePolicy, representedCall } from "@parley/policy";
import { createAudioCodec } from "@parley/audio";
import { GeminiRealtimeProvider, DEFAULT_GEMINI_MODEL } from "@parley/realtime-gemini";
import { TwilioTelephonyProvider } from "@parley/telephony-twilio";

const app = express();
app.use(express.json());

const telephony = new TwilioTelephonyProvider({
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN
});
const realtime = new GeminiRealtimeProvider({ apiKey: process.env.GEMINI_API_KEY });
const codec = createAudioCodec();

// A real caller posts a full { version, brief, policy } envelope — the same
// shape @parley/server's own POST /call expects (see @parley/policy's
// parseCallEnvelope). `policy` is composed upstream from a @parley/policy
// preset, e.g. representedCall({ principalName: "..." }); this route falls
// back to that same preset with fake sample data so it is runnable end to end
// without a real envelope.
const SAMPLE_POLICY = representedCall({ principalName: "Alex Rivera" });

app.post("/call", async (req, res) => {
  const brief = req.body.brief;
  const policy = req.body.policy ?? SAMPLE_POLICY;
  const session = new CallSession({
    brief,
    guardrails: composePolicy(policy),
    telephony,
    realtime,
    codec,
    from: process.env.TWILIO_FROM_NUMBER,
    answerWebhookUrl: `https://${process.env.PARLEY_PUBLIC_HOST}/twilio/answer`,
    model: DEFAULT_GEMINI_MODEL
  });
  const result = await session.originate();
  res.status(202).json({ callId: result.providerCallId });
  // A full embed also wires /twilio/answer + the media WS — see @parley/server.
});

app.listen(Number(process.env.PORT ?? 3335), () => console.log("express-minimal on :3335"));

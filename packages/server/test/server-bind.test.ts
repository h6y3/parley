/**
 * The daemon must not listen on every interface.
 *
 * Until 2026-08-17 `listen` read:
 *
 *     listen: (port) => new Promise((resolve) => server.listen(port, resolve))
 *
 * Node's `server.listen(port, host, callback)` takes the host second, so
 * passing the callback there means no host is supplied and Node binds `::`.
 * Confirmed on a running daemon: `lsof -nP -iTCP -sTCP:LISTEN` showed
 * `TCP *:3335 (LISTEN)` — reachable on every interface, where a loopback-bound
 * process shows `TCP 127.0.0.1:3335`. Nothing in the CLI plumbed a host, and no
 * env var existed to set one, so there was no configuration that could have
 * avoided it.
 *
 * A default argument is the fix, and a default is exactly the kind of thing a
 * later refactor drops silently — hence a test that binds a real socket and
 * reads the address back, rather than one that inspects the source.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { MULAW_8K } from "@parley/core";
import type { AudioCodec, FrameConverter, RealtimeProvider, TelephonyProvider } from "@parley/core";
import { createHostAllowlist, createNumberAllowlist } from "../src/allowlist.js";
import { createParleyServer } from "../src/server.js";

// Relabels without touching bytes: these tests verify wiring, not DSP.
const convert: FrameConverter = (f, to) => ({ encoding: to, data: f.data });
const canConvert = (): boolean => true;
const codec: AudioCodec = {
  dtmfTones: () => ({ encoding: MULAW_8K, data: Buffer.alloc(0) })
};
const realtime: RealtimeProvider = {
  name: "fake",
  audio: { accepts: [MULAW_8K], emits: MULAW_8K },
  openingDelivery: "turn",
  continuesAfterToolResponse: false,
  connect: vi.fn()
};
const telephony = {
  name: "fake",
  mediaEncoding: MULAW_8K,
  originate: vi.fn(async () => ({ providerCallId: "CA1", status: "queued" as const })),
  buildAnswerResponse: () => ({ contentType: "text/xml", body: "<Response/>" }),
  verifyWebhookSignature: () => true,
  attachMediaStream: () => ({
    sendOutboundAudio: () => {},
    clearOutboundBuffer: () => {},
    drainOutbound: async () => ({ confirmed: true, waitedMs: 0 }),
    close: () => {}
  }),
  hangup: async () => {}
} as unknown as TelephonyProvider;

function build() {
  return createParleyServer({
    telephony,
    realtime: {
      providers: { gemini: { provider: realtime, model: "gemini-3.1-flash-live-preview" } },
      default: "gemini"
    },
    codec,
    convert,
    canConvert,
    from: "+14155550001",
    publicHost: "voice.example.com",
    numberAllowlist: createNumberAllowlist(["+14155550002"]),
    hostAllowlist: createHostAllowlist(["voice.example.com"]),
    callToken: "t"
  });
}

let open: { close: () => Promise<void> } | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe("createParleyServer bind host", () => {
  it("binds loopback when no host is given", async () => {
    const handle = build();
    open = handle;
    await handle.listen(0);
    const addr = handle.server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("never binds the wildcard address by default", async () => {
    // The precise regression: `*:3335`. Node reports the wildcard as "::" or
    // "0.0.0.0" depending on stack, so both are named here.
    const handle = build();
    open = handle;
    await handle.listen(0);
    const addr = handle.server.address() as AddressInfo;
    expect(["::", "0.0.0.0"]).not.toContain(addr.address);
  });

  it("honours an explicit host so a container or test can still opt in", async () => {
    const handle = build();
    open = handle;
    await handle.listen(0, "127.0.0.1");
    const addr = handle.server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });
});

describe("createParleyServer realtime registry", () => {
  // The CLI checks this too, but the server is what every un-chosen call
  // depends on: constructed without its default, it would answer every such
  // call with a 503 — an outage, where this is a misconfiguration at boot.
  it("refuses to construct when the default provider is not built", () => {
    expect(() =>
      createParleyServer({
        telephony,
        realtime: {
          providers: { gemini: { provider: realtime, model: "gemini-3.1-flash-live-preview" } },
          default: "deepgram"
        },
        codec,
        convert,
        canConvert,
        from: "+14155550001",
        publicHost: "voice.example.com",
        numberAllowlist: createNumberAllowlist(["+14155550002"]),
        hostAllowlist: createHostAllowlist(["voice.example.com"]),
        callToken: "t"
      })
    ).toThrow('default realtime provider "deepgram" is not built');
  });
});

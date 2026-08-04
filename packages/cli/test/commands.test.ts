import { describe, expect, it, vi } from "vitest";
import { parseCallableNumbers, runCall, runDoctor, runPostCallCommand } from "../src/commands.js";

const envelopeFixture = () => ({
  version: 1,
  brief: { to: "+14155550002", persona: "p", objective: "o", facts: [] },
  policy: {
    principalName: "Alex Rivera",
    identity: { style: "self" },
    disclosure: { honestIfAsked: false, volunteer: false },
    scope: { lock: false },
    grounding: { antiInvention: true },
    deferral: { enabled: false },
    authority: {}
  }
});

describe("runCall", () => {
  it("POSTs the envelope file to the daemon and returns the callId", async () => {
    const envelope = envelopeFixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })) as unknown as typeof fetch;
    const out = await runCall(
      { to: "+14155550002", briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334" },
      { readFile: () => JSON.stringify(envelope), fetchImpl }
    );
    expect(out).toContain("CA555");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3334/call");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(envelope);
  });

  it("throws when --brief is missing", async () => {
    await expect(runCall({ to: "+1", briefPath: undefined, daemonUrl: "http://d" }, {})).rejects.toThrow(/--brief/);
  });

  it("throws when --to disagrees with the envelope's brief recipient", async () => {
    const envelope = envelopeFixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })) as unknown as typeof fetch;
    await expect(
      runCall(
        { to: "+19998887777", briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334" },
        { readFile: () => JSON.stringify(envelope), fetchImpl }
      )
    ).rejects.toThrow(/does not match/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not throw when --to matches the envelope's brief recipient", async () => {
    const envelope = envelopeFixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ callId: "CA555" }), { status: 202 })) as unknown as typeof fetch;
    const out = await runCall(
      { to: "+14155550002", briefPath: "b.json", daemonUrl: "http://127.0.0.1:3334" },
      { readFile: () => JSON.stringify(envelope), fetchImpl }
    );
    expect(out).toContain("CA555");
  });
});

describe("parseCallableNumbers", () => {
  it("returns [] when unset", () => {
    expect(parseCallableNumbers(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(parseCallableNumbers("")).toEqual([]);
  });

  it("parses a single number", () => {
    expect(parseCallableNumbers("+14155550002")).toEqual(["+14155550002"]);
  });

  it("trims whitespace and drops empty trailing entries", () => {
    expect(parseCallableNumbers("+14155550002, +14155550003 ,")).toEqual(["+14155550002", "+14155550003"]);
  });
});

describe("runPostCallCommand", () => {
  it("does nothing when no command or records path is configured", () => {
    const spawnImpl = vi.fn();
    expect(runPostCallCommand({ callId: "CA1" }, { spawnImpl: spawnImpl as never })).toBe(false);
    expect(runPostCallCommand({ command: "/bin/echo", callId: "CA1" }, { spawnImpl: spawnImpl as never })).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("starts the configured command with records path and call id", () => {
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    expect(
      runPostCallCommand(
        { command: "/opt/parley/post-call", recordsPath: "/tmp/calls.jsonl", callId: "CA1" },
        { spawnImpl: spawnImpl as never }
      )
    ).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith("/opt/parley/post-call", ["--records-path", "/tmp/calls.jsonl", "--call-id", "CA1"], {
      detached: true,
      stdio: "ignore"
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

describe("runDoctor", () => {
  it("reports presence booleans and never prints secret values", () => {
    const out = runDoctor({ env: { GEMINI_API_KEY: "sekret", TWILIO_AUTH_TOKEN: "", TWILIO_ACCOUNT_SID: "AC1", TWILIO_FROM_NUMBER: "+1" } });
    expect(out).toContain("GEMINI_API_KEY: present");
    expect(out).toContain("TWILIO_AUTH_TOKEN: MISSING");
    expect(out).not.toContain("sekret");
  });
});

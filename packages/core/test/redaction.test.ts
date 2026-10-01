import { describe, expect, it } from "vitest";
import { redactCloseReason, redactPhoneNumber, redactSecrets } from "../src/redaction.js";

describe("redactPhoneNumber", () => {
  it("masks all but the last 4 digits, preserving a leading +", () => {
    expect(redactPhoneNumber("+14155551234")).toBe("+*******1234");
  });

  it("masks a short string entirely rather than throwing", () => {
    expect(redactPhoneNumber("+1234")).toBe("*****");
  });
});

describe("redactSecrets", () => {
  it("redacts a top-level apiKey field, case-insensitively", () => {
    expect(redactSecrets({ apiKey: "fake", model: "gemini-3.1" })).toEqual({
      apiKey: "[redacted]", // # noscan (test fixture, not a real secret)
      model: "gemini-3.1"
    });
    expect(redactSecrets({ ApiKey: "fake" })).toEqual({ ApiKey: "[redacted]" }); // # noscan
  });

  it("redacts token/secret/password/authorization keys anywhere in a nested object", () => {
    expect(
      redactSecrets({
        providers: { google: { apiKey: "fake", apiVersion: "v1beta" } },
        auth: { authorization: "Bearer xyz", password: "hunter2" },
        note: "this token is not a key named token, so it stays"
      })
    ).toEqual({
      providers: { google: { apiKey: "[redacted]", apiVersion: "v1beta" } }, // # noscan
      auth: { authorization: "[redacted]", password: "[redacted]" }, // # noscan
      note: "this token is not a key named token, so it stays"
    });
  });

  it("redacts a sendDigits field — carrier-side DTMF typically carries a bridge passcode", () => {
    expect(redactSecrets({ sendDigits: "1234#", to: "+14155551234" })).toEqual({
      sendDigits: "[redacted]", // # noscan (test fixture, not a real secret)
      to: "+14155551234"
    });
  });

  it("does not over-match sendDigits' near neighbours: allowedDigits (config) and digits (a tool arg)", () => {
    // Neither of these carries a bridge passcode: allowedDigits is the
    // permitted-keypad-character config for the model's in-band press_digits
    // tool, and digits is that tool's own argument. Only the carrier-played
    // SendDigits at origination is the secret.
    expect(redactSecrets({ allowedDigits: "0123456789*#", digits: "1" })).toEqual({
      allowedDigits: "0123456789*#",
      digits: "1"
    });
  });

  it("redacts secrets inside arrays of objects", () => {
    expect(redactSecrets([{ secret: "shh" }, { fine: "ok" }])).toEqual([
      { secret: "[redacted]" }, // # noscan
      { fine: "ok" }
    ]);
  });

  it("leaves primitives untouched", () => {
    expect(redactSecrets("plain string")).toBe("plain string");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
  });
});

describe("redactSecrets diagnostics + prototype safety", () => {
  it("preserves an Error's message and name instead of collapsing to {}", () => {
    const out = redactSecrets(new Error("boom")) as { name: string; message: string };
    expect(out.name).toBe("Error");
    expect(out.message).toBe("boom");
  });

  it("still redacts secret-shaped keys inside a nested object", () => {
    const out = redactSecrets({ outer: { apiKey: "fakeval", label: "keep" } }) as {
      outer: { apiKey: string; label: string };
    };
    expect(out.outer.apiKey).toBe("[redacted]");
    expect(out.outer.label).toBe("keep");
  });

  it("does not prototype-pollute the returned object via a __proto__ key", () => {
    const out = redactSecrets(JSON.parse('{ "__proto__": { "polluted": true } }')) as Record<
      string,
      unknown
    >;
    // Old code set the returned object's [[Prototype]] to { polluted: true };
    // the fix (Object.create(null) + skipping __proto__) leaves it null.
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    // And the global prototype is likewise untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// Built at runtime so no fixture looks like a real credential to a scanner.
const fakeGoogleKey = "AIza" + "Sy" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7"; // # noscan
const fakeOpenAiKey = "sk-" + "proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2"; // # noscan
const fakeGithubToken = "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"; // # noscan
const fakeHexKey = "0123456789abcdef".repeat(2) + "deadbeef"; // # noscan

describe("redactCloseReason", () => {
  it("masks a +-prefixed phone number and key=value secrets, as before", () => {
    expect(redactCloseReason("call +14155550142 failed api_key=abc123")).toBe(
      "call +*******0142 failed api_key=[redacted]"
    );
  });

  it("masks a bare run of 10 or more digits, keeping the last four", () => {
    expect(redactCloseReason("caller 4155550142 rejected")).toBe("caller ******0142 rejected");
    expect(redactCloseReason("account 14155550142")).toBe("account *******0142");
  });

  it("leaves a short number alone", () => {
    expect(redactCloseReason("code 1011 after 300 seconds")).toBe("code 1011 after 300 seconds");
  });

  it.each([
    ["a Google API key", fakeGoogleKey],
    ["an sk- key", fakeOpenAiKey],
    ["a GitHub token", fakeGithubToken],
    ["a long hex key", fakeHexKey]
  ])("replaces %s standing on its own", (_label, secret) => {
    const out = redactCloseReason(`invalid credential ${secret} for project`);
    expect(out).toBe("invalid credential [redacted] for project");
  });

  it("keeps a UUID request id, which is not a credential", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(redactCloseReason(`request ${id} rejected`)).toBe(`request ${id} rejected`);
  });

  it("keeps a vendor's prose reason readable", () => {
    expect(redactCloseReason("Your prepayment credits are depleted. Please add more.")).toBe(
      "Your prepayment credits are depleted. Please add more."
    );
  });
});

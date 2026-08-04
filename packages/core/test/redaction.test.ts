import { describe, expect, it } from "vitest";
import { redactPhoneNumber, redactSecrets } from "../src/redaction.js";

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

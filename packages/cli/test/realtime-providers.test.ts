import { afterEach, describe, expect, it, vi } from "vitest";
import * as deepgram from "@parley/realtime-deepgram";
import { buildRealtimeProviders, main, resolveTimeZone } from "../src/cli.js";

// Pass-through spy so a test can see the options the CLI hands the provider.
vi.mock("@parley/realtime-deepgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@parley/realtime-deepgram")>();
  return {
    ...actual,
    createDeepgramRealtimeProvider: vi.fn(actual.createDeepgramRealtimeProvider)
  };
});

describe("buildRealtimeProviders", () => {
  it("builds only gemini when only GEMINI_API_KEY is set", () => {
    const built = buildRealtimeProviders({ GEMINI_API_KEY: "g-test" });
    expect(Object.keys(built)).toEqual(["gemini"]);
    expect(built.gemini?.model).toBe("gemini-3.8-live");
  });

  it("builds only deepgram when only DEEPGRAM_API_KEY is set, naming the think model", () => {
    const built = buildRealtimeProviders({ DEEPGRAM_API_KEY: "d-test" });
    expect(Object.keys(built)).toEqual(["deepgram"]);
    expect(built.deepgram?.model).toBe("gpt-4o-mini");
  });

  it("builds both when both keys are set", () => {
    const built = buildRealtimeProviders({ GEMINI_API_KEY: "g", DEEPGRAM_API_KEY: "d" });
    expect(Object.keys(built).sort()).toEqual(["deepgram", "gemini"]);
  });

  it("builds nothing when no key is set", () => {
    expect(buildRealtimeProviders({})).toEqual({});
  });

  it("honours the model env overrides", () => {
    const built = buildRealtimeProviders({
      GEMINI_API_KEY: "g",
      DEEPGRAM_API_KEY: "d",
      PARLEY_GEMINI_MODEL: "gemini-custom",
      PARLEY_DEEPGRAM_THINK_MODEL: "think-custom"
    });
    expect(built.gemini?.model).toBe("gemini-custom");
    expect(built.deepgram?.model).toBe("think-custom");
  });
});

describe("PARLEY_DEEPGRAM_SPEED", () => {
  it("defaults to the provider's default and accepts a valid override", () => {
    expect(() => buildRealtimeProviders({ DEEPGRAM_API_KEY: "d" })).not.toThrow();
    expect(() =>
      buildRealtimeProviders({ DEEPGRAM_API_KEY: "d", PARLEY_DEEPGRAM_SPEED: "1.2" })
    ).not.toThrow();
  });

  it("hands a valid env value to the provider as its speed option", () => {
    const create = vi.mocked(deepgram.createDeepgramRealtimeProvider);
    create.mockClear();
    buildRealtimeProviders({ DEEPGRAM_API_KEY: "d", PARLEY_DEEPGRAM_SPEED: "1.2" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ speed: 1.2 }));
    create.mockClear();
    buildRealtimeProviders({ DEEPGRAM_API_KEY: "d" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ speed: deepgram.DEFAULT_DEEPGRAM_SPEED })
    );
  });

  it("accepts the 0.7 and 1.5 boundaries and rejects just outside them", () => {
    for (const ok of ["0.7", "1.5"]) {
      expect(() =>
        buildRealtimeProviders({ DEEPGRAM_API_KEY: "d", PARLEY_DEEPGRAM_SPEED: ok })
      ).not.toThrow();
    }
    for (const bad of ["0.69", "1.51"]) {
      expect(() =>
        buildRealtimeProviders({ DEEPGRAM_API_KEY: "d", PARLEY_DEEPGRAM_SPEED: bad })
      ).toThrow(/PARLEY_DEEPGRAM_SPEED/);
    }
  });

  it("fails boot naming only the variable when invalid or out of range", () => {
    for (const bad of ["fast", "0.6", "1.6", "NaN"]) {
      const err = (() => {
        try {
          buildRealtimeProviders({
            DEEPGRAM_API_KEY: "d-secret",
            PARLEY_DEEPGRAM_SPEED: bad
          });
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err?.message).toContain("PARLEY_DEEPGRAM_SPEED");
      expect(err?.message).not.toContain("d-secret");
    }
  });
});

describe("serve default provider", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails at boot when the default provider has no credential", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    await expect(main(["serve", "--realtime-provider", "deepgram"])).rejects.toThrow(
      'default realtime provider "deepgram" has no credential'
    );
  });
});

describe("PARLEY_TIMEZONE", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts an IANA name and treats unset as the host zone", () => {
    expect(resolveTimeZone({ PARLEY_TIMEZONE: "Asia/Tokyo" })).toBe("Asia/Tokyo");
    expect(resolveTimeZone({})).toBeUndefined();
  });

  it("fails boot naming only the variable when the zone is invalid", async () => {
    vi.stubEnv("PARLEY_TIMEZONE", "Not/AZone");
    vi.stubEnv("GEMINI_API_KEY", "g-secret");
    const error = await main(["serve"]).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("PARLEY_TIMEZONE");
    expect((error as Error).message).not.toContain("g-secret");
  });
});

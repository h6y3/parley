import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@parley/harness scaffold", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@parley/harness");
  });
});

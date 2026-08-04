import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@parley/server barrel", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@parley/server");
  });
});

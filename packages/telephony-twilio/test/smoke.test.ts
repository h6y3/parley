import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@parley/telephony-twilio barrel", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@parley/telephony-twilio");
  });
});

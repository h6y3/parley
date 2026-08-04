import { describe, expect, it } from "vitest";
import { buildStreamTwiml } from "../src/twiml.js";

describe("buildStreamTwiml", () => {
  it("emits a Connect/Stream TwiML pointing at the media URL", () => {
    const xml = buildStreamTwiml("wss://voice.example.com/media/CA123");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<Connect>");
    expect(xml).toContain('<Stream url="wss://voice.example.com/media/CA123"');
    expect(xml).toContain("</Response>");
  });

  it("XML-escapes an ampersand in the URL", () => {
    const xml = buildStreamTwiml("wss://h/media/CA1?a=1&b=2");
    expect(xml).toContain("a=1&amp;b=2");
    expect(xml).not.toContain("a=1&b=2");
  });
});

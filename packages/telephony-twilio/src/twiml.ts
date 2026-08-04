function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the TwiML the answer webhook returns: a bidirectional Media Stream
 * connected to Parley's per-call media WebSocket URL (design spec §3, §7.1). */
export function buildStreamTwiml(mediaStreamUrl: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response><Connect>" +
    `<Stream url="${escapeXmlAttr(mediaStreamUrl)}"/>` +
    "</Connect></Response>"
  );
}

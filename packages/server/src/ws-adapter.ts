import type { WebSocket as WsSocket } from "ws";
import type { WebSocketLike } from "@parley/core";

/** Adapt a `ws` WebSocket to Parley's minimal WebSocketLike (design spec §7.1).
 * Twilio Media Streams uses text frames; a text frame's data arrives as a
 * Buffer under `ws`, so it is decoded to a string before reaching the listener. */
export function wrapWsSocket(ws: WsSocket): WebSocketLike {
  return {
    send: (data) => ws.send(data),
    on: (event, listener) => {
      if (event === "message") {
        ws.on("message", (data: Buffer, isBinary: boolean) => listener(isBinary ? data : data.toString("utf8")));
      } else {
        ws.on(event, listener as (...args: unknown[]) => void);
      }
    },
    close: () => ws.close()
  };
}

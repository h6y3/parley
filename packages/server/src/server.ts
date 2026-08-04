import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AudioCodec, RealtimeProvider, TelephonyProvider } from "@parley/core";
import type { NumberAllowlist, HostAllowlist } from "./allowlist.js";
import { handleMediaConnection, type CompletedCallRecord } from "./media-connection.js";
import { PendingSessions } from "./pending-sessions.js";
import { handleHttpRequest, type ServerDeps } from "./request-handler.js";
import { wrapWsSocket } from "./ws-adapter.js";

// Twilio form webhooks are tiny; audio rides the WS, not HTTP POST. Cap
// pre-auth body buffering so an unauthenticated caller can't exhaust memory.
const MAX_BODY_BYTES = 64 * 1024;

export interface ParleyServerConfig {
  telephony: TelephonyProvider;
  realtime: RealtimeProvider;
  codec: AudioCodec;
  from: string;
  publicHost: string;
  model: string;
  numberAllowlist: NumberAllowlist;
  hostAllowlist: HostAllowlist;
  onCallCompleted?: (record: CompletedCallRecord) => void;
}

export function createParleyServer(config: ParleyServerConfig): {
  server: Server;
  listen: (port: number) => Promise<void>;
  close: () => Promise<void>;
} {
  const pending = new PendingSessions();
  const deps: ServerDeps = { ...config, pending };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      if (rejected) return;
      byteLength += c.length;
      if (byteLength > MAX_BODY_BYTES) {
        rejected = true;
        res.writeHead(413);
        res.end("payload too large");
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      void (async () => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? config.publicHost}`);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
        const response = await handleHttpRequest(
          { method: req.method ?? "GET", path: url.pathname, query: url.search.replace(/^\?/, ""), headers, rawBody: Buffer.concat(chunks).toString("utf8") },
          deps
        );
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      })().catch(() => {
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } catch {
          /* headers already sent — nothing more to do */
        }
      });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? config.publicHost}`);
    const host = (req.headers.host ?? "").split(":")[0];
    const match = /^\/media\/([^/]+)$/.exec(url.pathname);
    if (!match || !config.hostAllowlist.permits(host)) {
      socket.destroy();
      return;
    }
    const callId = decodeURIComponent(match[1]);
    wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
      void handleMediaConnection(callId, wrapWsSocket(ws), { pending, onCallCompleted: config.onCallCompleted }).catch(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      });
    });
  });

  return {
    server,
    listen: (port) => new Promise((resolve) => server.listen(port, resolve)),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

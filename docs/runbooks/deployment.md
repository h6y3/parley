# Runbook: deploying Parley as a long-lived service

This runbook covers running the Parley daemon (`@parley/server`, driven by `parley serve`) as a
supervised, always-on service that Twilio can reach over the public internet. It is
**ingress-agnostic and host-agnostic** — pick whichever process supervisor and tunnel/proxy match
your platform. Every value below is a sample (`com.example.parley`, `voice.example.com`,
`/etc/parley/parley.env`) — substitute your own.

This is infrastructure work, executed separately from the library. Nothing in this repo's build or
CI performs a deployment; this runbook only documents how to do it by hand (or wire it into your
own configuration-management/IaC tooling).

---

## Prerequisites

- **A built repo:**

  ```bash
  pnpm install
  pnpm build
  ```

- **A filled `.env`.** Copy `.env.example` to `.env` and fill in the required variables —
  `GEMINI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
  `PARLEY_PUBLIC_HOST`, `PARLEY_PORT` (defaults to `3334` if unset), `PARLEY_CALLABLE_NUMBERS`
  (comma-separated E.164 allowlist), and optionally `PARLEY_CALL_RECORDS_PATH` and
  `PARLEY_POST_CALL_COMMAND`. `parley doctor` checks which required secrets are present without
  ever printing their values — run it before going further.
- **A purchased Twilio number** capable of voice, with its "from" number matching
  `TWILIO_FROM_NUMBER`.
- **A public HTTPS endpoint** that forwards to the daemon's `PARLEY_PORT` on `127.0.0.1`. Twilio's
  webhooks and the media-stream WebSocket both need to reach this endpoint over TLS — see
  **Public ingress** below.

`parley serve` reads all configuration and secrets from the process environment — never from a CLI
flag or a committed file — so however you supervise it, your job is only to get `.env`'s contents
into that process's environment before it starts.

---

## Running as a service — launchd (macOS)

Use a wrapper script so the plist doesn't need to parse `.env` itself:

`~/.config/parley/serve.sh`:

```bash
#!/bin/bash
set -euo pipefail
set -a
source /path/to/parley/.env
set +a
exec /path/to/parley/packages/cli/dist/cli.js serve
```

```bash
chmod +x ~/.config/parley/serve.sh
```

`~/Library/LaunchAgents/com.example.parley.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.parley</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>~/.config/parley/serve.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- A long-lived outbound audio pacer (20 ms frame cadence) is timing-sensitive. A default
       (throttled) launchd agent is subject to App Nap / timer coalescing, which makes pacing
       choppy under load even though the connection itself looks healthy. Interactive exempts
       the process from that throttling. -->
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>/tmp/com.example.parley.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/com.example.parley.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.example.parley.plist
# ... and to stop/reverse:
launchctl unload ~/Library/LaunchAgents/com.example.parley.plist
```

---

## Running as a service — systemd (Linux)

`/etc/parley/parley.env` (mode `600`, same variables as `.env.example`):

```bash
GEMINI_API_KEY=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15555550100
PARLEY_PUBLIC_HOST=voice.example.com
PARLEY_PORT=3334
PARLEY_CALLABLE_NUMBERS=+15555550101,+15555550102
```

`/etc/systemd/system/parley.service`:

```ini
[Unit]
Description=Parley voice-call daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/parley/parley.env
ExecStart=/usr/bin/parley serve
Restart=on-failure
RestartSec=5
User=parley
Group=parley

[Install]
WantedBy=multi-user.target
```

`/usr/bin/parley` is the `parley` bin (see `packages/cli/package.json`'s `bin` field) —
either `npm install -g @parley/cli` or a symlink to the built `packages/cli/dist/cli.js`.

```bash
systemctl daemon-reload
systemctl enable --now parley
journalctl -u parley -f
# ... and to stop/reverse:
systemctl disable --now parley
```

---

## Public ingress

Run any HTTPS tunnel or reverse proxy in front of the daemon — a Cloudflare Tunnel, `ngrok`, or
`nginx` + `certbot` all work identically from Parley's point of view. Map:

```
https://$PARLEY_PUBLIC_HOST  →  127.0.0.1:$PARLEY_PORT
```

The value of `PARLEY_PUBLIC_HOST` in `.env` **must match** the hostname Twilio's webhook actually
reaches — the daemon's SSRF-safe host allowlist (`createHostAllowlist`, wired in
`packages/cli/src/cli.ts`) is built from this single value and rejects requests whose `Host` header
doesn't match it (see `docs/security-model.md`).

Verify the mapping is live with a `GET` to the health path:

```bash
curl -sS https://$PARLEY_PUBLIC_HOST/healthz
# expect: {"ok":true}
```

(`GET /healthz` is unauthenticated and side-effect-free — see
`packages/server/src/request-handler.ts` — safe to poll repeatedly.)

---

## Twilio wiring

Point the phone number's voice webhook (or the outbound TwiML your calling code generates) at:

```
https://$PARLEY_PUBLIC_HOST/twilio/answer
```

This is the daemon's `POST /twilio/answer` route (`packages/server/src/request-handler.ts`),
which returns the TwiML that opens the Media Streams WebSocket back to the daemon for the
call's duration.

---

## Post-call hook

Set `PARLEY_POST_CALL_COMMAND` (and, if you want a persistent record, `PARLEY_CALL_RECORDS_PATH`)
if you want a per-call follow-up — the daemon writes a completed-call JSONL record to
`PARLEY_CALL_RECORDS_PATH` and then invokes `PARLEY_POST_CALL_COMMAND` with the records path and
call id, so you can wire in your own summarizer, notifier, or archival step.

---

## Reverse / rollback

To take the service out of the call path, in order:

1. **Repoint or drop the ingress mapping** — stop routing `$PARLEY_PUBLIC_HOST` at the daemon's
   port (restore a prior tunnel config, or tear down the mapping entirely). Twilio calls to the
   webhook will start failing immediately, which is the intended stop condition before further
   rollback.
2. **Unload/stop the service** — `launchctl unload ...` (macOS) or `systemctl disable --now parley`
   (Linux).

Because `.env`/`parley.env` and the ingress mapping are the only state involved, restoring either
independently (repoint ingress back, or restart the service) is enough to reverse a partial
rollout at any point.

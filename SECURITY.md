# Security Policy

## Supported versions

Parley is pre-1.0; the latest `main` receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's **Security → Report a
vulnerability** (private advisory). Do not open a public issue for a security
report. We aim to acknowledge within a few days.

## Security model (summary)

Parley is fail-closed by design:

- **Twilio signature verification** on every inbound webhook.
- **SSRF-safe host allowlist** for any outbound webhook/callback target.
- **Callable-number allowlist** (`PARLEY_CALLABLE_NUMBERS`) — the daemon
  refuses to dial a number not on it.
- **No call recording.**
- **Secrets never travel in a Brief or envelope.** The daemon holds all
  credentials; a caller's payload carries only call content.

See [`docs/security-model.md`](docs/security-model.md) for the full model.

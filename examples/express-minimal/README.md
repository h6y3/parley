# `examples/express-minimal` — embedding the library directly

This example is **illustrative only**: it shows `@parley/core` plus the Twilio and Gemini
provider packages embedded directly inside a small Express app, bypassing the standalone
`@parley/server` daemon entirely, to demonstrate that Parley is usable as a set of libraries and
not only as a daemon. `server.mjs` wires `originate()` for a single route and stops there — it
does **not** wire the `/twilio/answer` webhook or the media-stream WebSocket, so as written it
cannot carry a real call end to end. This package is **not** part of the pnpm workspace, is not
built, and `express` is not installed anywhere in this repo; treat `server.mjs` as reference code
to copy from, not something to run as-is. For the complete, secure-by-default path — signature
verification, host allowlist, callable-number allowlist, media-stream correlation, and the rest
of `docs/security-model.md`'s guarantees, all wired and tested — use `@parley/server` (`parley
serve`) instead.

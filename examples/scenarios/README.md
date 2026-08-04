# Example scenario library

Twelve complete call envelopes covering Parley's three calling modes —
**principal** (calling Alex directly), **represented** (calling someone on
Alex's behalf, with disclosure if asked), and **transactional** (a routine
errand call where the assistant doesn't identify itself unless asked). Each
file is a full, schema-valid `{ version, brief, policy }` envelope you can
read as a reference or run as-is.

All scenarios use the same sample identity: principal **Alex Rivera**,
assistant **Ada**, callback `+15555550123`. `to` numbers use the reserved
fictional `555-01XX` range and are distinct per file. Any business names
(Sunrise Diner, Willow Salon, Central Pharmacy, Harbor Hardware) are
fictional.

| Scenario file                  | Mode          | Demonstrates                                                      | Description                                         |
| ------------------------------ | ------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `restaurant-reservation.json`  | represented   | `authorizedCommitments`, callback, voicemail `leaveMessage`       | Book a table for four this Friday at 7pm.           |
| `doctor-appointment.json`      | represented   | `pronunciation`, empty `authority`, voicemail `leaveMessage`      | Schedule a routine physical within two weeks.       |
| `plumber-scheduling.json`      | represented   | `authorizedCommitments` + `extraGuardrails` (no price commitment) | Schedule a plumber visit for a leaking faucet.      |
| `takeout-order.json`           | transactional | silent identity with `recipientName`, voicemail `hangUp`          | Place a pickup order at a diner.                    |
| `salon-booking.json`           | transactional | silent identity, `extraGuardrails` (don't assume booked)          | Book a Saturday-morning haircut.                    |
| `pharmacy-refill-status.json`  | transactional | silent identity, info-only call (no booking, empty `authority`)   | Check whether a prescription refill is ready.       |
| `self-morning-briefing.json`   | principal     | self identity, `grounding.antiInvention`, `extraGuardrails`       | Read Alex the day's schedule and flag decisions.    |
| `self-reminder.json`           | principal     | self identity, no disclosure fields needed                        | Remind Alex of a 3pm dentist appointment.           |
| `vendor-invoice-followup.json` | represented   | `authority.alwaysDefer` (never commit to a fee)                   | Follow up on an outstanding invoice/quote.          |
| `event-rsvp.json`              | represented   | `authorizedCommitments` for a fixed headcount                     | RSVP yes for two to an event.                       |
| `business-hours-check.json`    | transactional | silent identity, pure info query, empty `authority`               | Ask what time a store closes today.                 |
| `appointment-reschedule.json`  | represented   | `authorizedCommitments` over a date range, callback               | Reschedule an existing appointment to a new window. |

## Validate

Every file in this directory is checked against the `@parley/policy` schema
via `parseCallEnvelope`:

```bash
pnpm --filter @parley/policy build
node examples/scenarios/validate.mjs
```

Expected output: `ok` for all 12 files, exit code 0.

## Run one

Each file is a complete call envelope. With the daemon running:

    parley call --to +15555550140 --brief examples/scenarios/restaurant-reservation.json

`--to` is optional and, if given, must match the file's `brief.to` exactly (it's
a copy-paste mismatch guard, not an override) — and that number must be on your
`PARLEY_CALLABLE_NUMBERS` allowlist.

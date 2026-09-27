# Derail-scenario audio fixtures

16kHz PCM16LE (`.pcm`) caller-turn audio, one file per non-silence entry in
`DERAIL_SCENARIOS` and `MEETING_SCENARIOS`, played into a real Gemini Live
session by the `reliability` gate. The `silence` and `hold-music` scenarios
have no fixture (both are dead-air turns).

## Regenerate (manual — requires GEMINI_API_KEY, makes live TTS calls)

    GEMINI_API_KEY=… pnpm --filter @parley/harness run fixtures:generate

This renders every `DERAIL_SCENARIOS` and `MEETING_SCENARIOS` entry's
`calleeLine` via Gemini TTS and resamples it to 16kHz with @parley/audio.
Commit the resulting `derail/*.pcm` files. CI never runs this step — it is the
same manual, key-gated tier as the reliability run.

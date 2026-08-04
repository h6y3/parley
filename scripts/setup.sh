#!/usr/bin/env bash
# scripts/setup.sh — one-shot Parley bootstrap. Idempotent and non-destructive.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Checking prerequisites"
command -v node >/dev/null || { echo "ERROR: Node is not installed (need >=20). See https://nodejs.org"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "ERROR: Node >=20 required, found $(node -v)"; exit 1; }
if ! command -v pnpm >/dev/null; then
  echo "pnpm not found; enabling via corepack"
  corepack enable >/dev/null 2>&1 || { echo "ERROR: install pnpm (https://pnpm.io) then re-run"; exit 1; }
fi

echo "==> Installing dependencies"
pnpm install

echo "==> Building"
pnpm build

if [ ! -f .env ]; then
  echo "==> Scaffolding .env from .env.example (fill in the values below)"
  cp .env.example .env
  echo "    Created .env — set these before running 'parley serve':"
  grep -vE '^\s*#' .env | grep -E '=' | sed -E 's/=.*//;s/^/      - /' || true
else
  echo "==> .env already present — leaving it untouched"
fi

echo "==> Running parley doctor"
node packages/cli/dist/cli.js doctor || echo "(doctor reported issues — fill in .env, then re-run: parley doctor)"

echo "==> Done. Next: fill .env, run 'parley serve', then 'parley call --to <number> --brief examples/briefs/represented.json'"

#!/usr/bin/env bash
# Seed a single-use enrollment or recovery token (operator-only, via
# wrangler — never an online flow). Prints the token once; only its hash is
# stored. Usage: scripts/seed-token.sh [enroll|recover] [--remote]
set -euo pipefail
cd "$(dirname "$0")/.."

PURPOSE="${1:-enroll}"
case "$PURPOSE" in enroll|recover) ;; *) echo "purpose must be enroll or recover" >&2; exit 1 ;; esac
TARGET="--local"
[ "${2:-}" = "--remote" ] && TARGET="--remote"

TOKEN=$(openssl rand -base64 33 | tr '+/' '-_' | tr -d '=')
HASH=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')
NOW=$(date +%s)000

npx wrangler d1 execute mindash "$TARGET" --command \
  "INSERT INTO auth_tokens (token_hash, purpose, created_at) VALUES ('$HASH', '$PURPOSE', $NOW)" >/dev/null

echo "single-use $PURPOSE token (shown once, hash stored):"
echo "$TOKEN"

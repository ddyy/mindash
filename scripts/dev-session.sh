#!/usr/bin/env bash
# Mint a signed-in session against a LOCAL dev database, for agents and
# humans who need the editor without a passkey ceremony on this machine.
#
# This is NOT an auth bypass: the Worker has no code path that skips
# WebAuthn. It writes the same credential + session rows a real ceremony
# would leave behind, using the operator's own wrangler binding — the
# mechanism test/integration/auth.mjs already uses to seed its owner.
# Nothing here exists as an HTTP surface, and --remote is refused outright.
#
# Usage: scripts/dev-session.sh [--persist-to DIR]
#   Prints a Cookie header. Pass it to curl, or set it in the browser:
#     curl -s -H "$(scripts/dev-session.sh)" http://localhost:8813/settings/editor
set -euo pipefail
cd "$(dirname "$0")/.."

PERSIST="../scratch/wrangler-ar" # matches .claude/launch.json's dev server
while [ $# -gt 0 ]; do
  case "$1" in
    --persist-to) PERSIST="$2"; shift 2 ;;
    --remote) echo "refusing: this seeds a session, and never against production" >&2; exit 1 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

TOKEN=$(openssl rand -hex 24)
HASH=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')
NOW=$(date +%s)000
EXPIRES=$((NOW + 86400000)) # one day; re-run for another

# The session must carry the CURRENT owner epoch, or the first request
# rejects it as revoked. owner_state is seeded by bootstrap; default to 1
# when this database has not been claimed yet.
npx wrangler d1 execute mindash --local --persist-to "$PERSIST" --command \
  "INSERT OR IGNORE INTO credentials (credential_id, public_key, counter, created_at)
     VALUES ('dev-session-cred', 'ZGV2', 0, $NOW);
   INSERT INTO sessions (session_hash, credential_id, epoch, created_at, expires_at)
     VALUES ('$HASH', 'dev-session-cred', COALESCE((SELECT epoch FROM owner_state WHERE id = 1), 1), $NOW, $EXPIRES)" >/dev/null

echo "Cookie: session=$TOKEN"

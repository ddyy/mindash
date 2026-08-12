#!/usr/bin/env bash
# Seed a scoped MCP bearer token (secondary lane for header-capable
# clients). Prints the token once; only its hash is stored, stamped with
# the current owner epoch so recovery revokes it.
# Usage: scripts/seed-mcp-token.sh [layout|sources] [label] [--remote]
set -euo pipefail
cd "$(dirname "$0")/.."

SCOPE="${1:-layout}"
case "$SCOPE" in
  layout)  SCOPES="layout" ;;
  sources) SCOPES="layout,sources" ;;
  *) echo "scope must be layout or sources" >&2; exit 1 ;;
esac
LABEL="${2:-cli}"
TARGET="--local"
[ "${3:-}" = "--remote" ] && TARGET="--remote"

TOKEN=$(openssl rand -base64 33 | tr '+/' '-_' | tr -d '=')
HASH=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')
NOW=$(date +%s)000

npx wrangler d1 execute mindash "$TARGET" --command \
  "INSERT INTO mcp_tokens (token_hash, scopes, epoch, label, created_at) VALUES ('$HASH', '$SCOPES', (SELECT epoch FROM owner_state WHERE id = 1), '$LABEL', $NOW)" >/dev/null

echo "mcp token (scopes: $SCOPES, label: $LABEL) — shown once:"
echo "$TOKEN"

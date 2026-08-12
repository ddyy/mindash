#!/usr/bin/env bash
# DCR admission regression: quota counts only unexpired slots, failed
# registrations release capacity, and expiry frees it — registration must
# work again after earlier clients expire (the lifetime-counter bug).
# Runs a real wrangler dev instance against isolated state OUTSIDE the
# repository (removed on exit). --local disables remote bindings: the
# Browser binding is remote by design for local development, but CI has
# no Cloudflare credentials and would hang establishing that session.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT=8790
STATE=$(mktemp -d "${TMPDIR:-/tmp}/mindash-int.XXXXXX")
DEV_PID=""
cleanup() {
  [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true
  case "$STATE" in /tmp/*|"${TMPDIR:-/tmp}"*) rm -rf "$STATE" ;; esac
}
trap cleanup EXIT
npx wrangler dev --local --port $PORT --persist-to "$STATE" --compatibility-flags nodejs_compat \
  --var DCR_MAX_ACTIVE:3 --var DCR_MAX_PER_WINDOW:50 >/tmp/mindash-int.log 2>&1 &
DEV_PID=$!
# bounded readiness loop — no packages beyond the lockfile
for i in $(seq 1 60); do
  curl -sf -o /dev/null "http://localhost:$PORT/login" && break
  [ "$i" = 60 ] && { echo "server never became ready"; tail -20 /tmp/mindash-int.log; exit 1; }
  sleep 1
done

reg() { # $1: client_name; $2: redirect uri; prints http status
  curl -s -o /tmp/dcr-resp.json -w "%{http_code}" -X POST "http://localhost:$PORT/register" \
    -H "content-type: application/json" \
    -d "{\"redirect_uris\":[\"$2\"],\"token_endpoint_auth_method\":\"none\",\"client_name\":\"$1\"}"
}
expect() { # $1 actual; $2 expected; $3 label
  if [ "$1" != "$2" ]; then echo "FAIL: $3 — got $1, expected $2"; cat /tmp/dcr-resp.json; exit 1; fi
  echo "ok: $3 ($1)"
}

CB="https://claude.ai/api/mcp/auth_callback"
expect "$(reg c1 $CB)" 201 "first registration admitted"
expect "$(reg c2 $CB)" 201 "second registration admitted"
expect "$(reg bad 'http://not-allowed.example/cb')" 400 "invalid metadata rejected"
expect "$(reg c3 $CB)" 201 "failed registration released its slot (third valid admitted)"
expect "$(reg c4 $CB)" 429 "quota enforced at capacity"
npx wrangler d1 execute mindash --local --persist-to "$STATE" \
  --command "UPDATE dcr_slots SET expires_at = 1" >/dev/null 2>&1
expect "$(reg c5 $CB)" 201 "registration works again after earlier clients expire"
echo "DCR integration: all assertions passed"

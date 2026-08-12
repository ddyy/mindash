#!/usr/bin/env bash
# Promote the KV-held vault master key into the MASTER_KEY Worker secret
# WITHOUT printing the key or passing it as a command-line argument (it
# travels shell variable -> stdin only).
#
#   scripts/promote-master-key.sh            # copy KV key into the secret
#   scripts/promote-master-key.sh --finish   # remove the KV copy — only
#                                            # after the DEPLOYED Worker has
#                                            # proven the secret works
#
# --finish refuses unless ALL of these hold:
#   1. the KV key's fingerprint matches the stored vault fingerprint
#      (the KV key really is the key that sealed existing data), and
#   2. the deployed Worker has written a promotion receipt
#      (vault:master-key-verified) proving it decrypted successfully
#      USING the MASTER_KEY secret, and the receipt matches that same
#      fingerprint.
# So a missing, mistargeted, or overwritten MASTER_KEY can never lead to
# deleting the only recoverable copy of the key.
set -euo pipefail
cd "$(dirname "$0")/.."

NS_ID=$(node -e '
  const fs = require("fs");
  const txt = fs.readFileSync("wrangler.jsonc", "utf8").replace(/\/\/[^\n]*/g, "");
  const cfg = JSON.parse(txt);
  const kv = (cfg.kv_namespaces || []).find((n) => n.binding === "OAUTH_KV");
  if (!kv || !kv.id || kv.id.startsWith("REPLACE")) { console.error("OAUTH_KV id not configured in wrangler.jsonc"); process.exit(1); }
  console.log(kv.id);
')

kv_get() { npx wrangler kv key get "$1" --namespace-id "$NS_ID" --remote 2>/dev/null || true; }

fingerprint_of() { # stdin: base64url key -> stdout: base64url sha256 (matches the Worker's)
  node -e '
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", async () => {
      const b64 = Buffer.concat(chunks).toString("utf8").trim();
      const raw = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const d = Buffer.from(await crypto.subtle.digest("SHA-256", raw));
      console.log(d.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    });
  '
}

if [ "${1:-}" = "--finish" ]; then
  KEY=$(kv_get "vault:master-key")
  if [ -z "$KEY" ]; then echo "No KV vault key present — nothing to finish."; exit 0; fi
  FP_STORED=$(kv_get "vault:key-fingerprint")
  RECEIPT=$(kv_get "vault:master-key-verified")
  CHALLENGE=$(kv_get "vault:promotion-challenge")
  FP_KV=$(printf '%s' "$KEY" | fingerprint_of)
  unset KEY
  if [ -z "$FP_STORED" ] || [ "$FP_KV" != "$FP_STORED" ]; then
    echo "REFUSING: the KV key does not match the stored vault fingerprint."
    echo "Something is inconsistent — do not delete anything. Investigate first."
    exit 1
  fi
  if [ -z "$CHALLENGE" ]; then
    echo "REFUSING: no promotion challenge found — run the promotion phase first."
    exit 1
  fi
  if [ "$RECEIPT" != "${FP_STORED}|${CHALLENGE}" ]; then
    echo "REFUSING: the deployed Worker has not proven the CURRENT promotion's"
    echo "MASTER_KEY works. The receipt must carry this promotion's challenge"
    echo "and the matching key fingerprint — a receipt from an earlier promotion"
    echo "does not count. Deploy (so the secret is live), open Settings or let a"
    echo "credentialed widget refresh once, then re-run --finish."
    exit 1
  fi
  echo "Verified: KV key matches the vault fingerprint AND the deployed Worker"
  echo "decrypted successfully with THIS promotion's MASTER_KEY. Removing the KV copy..."
  npx wrangler kv key delete "vault:master-key" --namespace-id "$NS_ID" --remote
  npx wrangler kv key delete "vault:master-key-verified" --namespace-id "$NS_ID" --remote >/dev/null 2>&1 || true
  npx wrangler kv key delete "vault:promotion-challenge" --namespace-id "$NS_ID" --remote >/dev/null 2>&1 || true
  echo "Done. The key now exists only as the write-only MASTER_KEY secret."
  exit 0
fi

KEY=$(kv_get "vault:master-key")
if [ -z "$KEY" ]; then
  echo "No KV vault key found. Either the vault has never sealed anything"
  echo "(safe to just set a fresh secret: openssl rand 32 | basenc --base64url | tr -d '=' | npx wrangler secret put MASTER_KEY)"
  echo "or MASTER_KEY is already in use."
  exit 1
fi

# fresh challenge for THIS promotion; the prior receipt is cleared so it
# can never authorize a later --finish
CHALLENGE=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
npx wrangler kv key delete "vault:master-key-verified" --namespace-id "$NS_ID" --remote >/dev/null 2>&1 || true
printf '%s' "$CHALLENGE" | npx wrangler kv key put "vault:promotion-challenge" --namespace-id "$NS_ID" --remote >/dev/null 2>&1 ||   npx wrangler kv key put "vault:promotion-challenge" "$CHALLENGE" --namespace-id "$NS_ID" --remote

printf '%s' "$KEY" | npx wrangler secret put MASTER_KEY
unset KEY
echo
echo "MASTER_KEY set to the exact existing vault key. Now:"
echo "  1. Deploy (or wait for the next deploy) so the secret is live."
echo "  2. Open Settings or let a credentialed widget refresh once — the Worker"
echo "     records a promotion receipt when MASTER_KEY decrypts successfully."
echo "  3. Then remove the KV copy:  scripts/promote-master-key.sh --finish"
echo "     (--finish refuses until the receipt exists and everything matches)"

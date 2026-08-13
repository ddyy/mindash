#!/usr/bin/env bash
# Bundle each test with the same text-loaders the Worker uses, then run
# with the node:test runner. No test-framework dependency.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .test-dist
npx esbuild test/*.test.ts --bundle --platform=node --format=cjs \
  --loader:.yaml=text --loader:.css=text --loader:.client.js=text --loader:.sql=text \
  --outdir=.test-dist --out-extension:.js=.cjs --log-level=warning
node --test .test-dist/*.test.cjs

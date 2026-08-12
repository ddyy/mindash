#!/usr/bin/env bash
# Zip the extension for a Chrome Web Store upload. The zip root must be
# the manifest's directory, not a folder containing it.
set -euo pipefail
cd "$(dirname "$0")/../extension"
rm -f ../extension.zip
zip -qr ../extension.zip . -x "README.md"
echo "wrote $(cd .. && pwd)/extension.zip"

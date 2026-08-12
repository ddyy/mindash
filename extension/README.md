# mindash new tab (browser extension)

Opens your mindash instance in every new tab. Stores exactly one value -
your dashboard URL (in `chrome.storage.sync`, so it follows your browser
profile) - and requests only the `storage` permission. No analytics, no
network access of its own: the new tab simply navigates to your URL.

The first new tab after installing shows a one-field setup form; change
the URL later via the extension's Options.

## Load it unpacked (Chrome / Edge / Brave)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `extension/` folder.
3. Open a new tab, enter your instance URL, done.

Firefox: `about:debugging` → This Firefox → **Load Temporary Add-on** →
pick `manifest.json` (temporary add-ons unload on restart).

## Package for the Chrome Web Store

```bash
./scripts/pack-extension.sh   # writes extension.zip next to the repo root
```

Upload the zip in the [developer dashboard](https://chrome.google.com/webstore/devconsole).
Listing notes: single purpose = "replace the new tab page with the
user's self-hosted dashboard"; permissions justification = `storage`
holds the dashboard URL; no user data is collected or transmitted.

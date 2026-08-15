# mindash new tab (browser extension)

Opens your mindash instance in every new tab, painting the last-seen
page instantly while the live one loads. Stores two things, both local
to your browser: your dashboard URL (`chrome.storage.sync`, so it
follows your profile) and a snapshot of the last page it fetched
(`chrome.storage.local`, this machine only). Installs with only the
`storage` permission; at setup it asks - optionally - for access to your
dashboard's own origin, which is what lets it fetch the snapshot with
your session. Decline and every new tab simply navigates, exactly as
before. No analytics, and no request ever leaves for any other origin.

Why the snapshot: an authed dashboard is deliberately served no-store,
so a plain new tab pays a full network round trip while showing blank.
The snapshot paints at 0ms (scripts stripped, links still work), the
extension refetches in the background, and the tab then hands over to
the live page. Signing out clears it on the next open; offline, the
snapshot stays up instead of a browser error page.

The first new tab after installing shows a one-field setup form. To
change the URL later, click the extension's toolbar icon - the same
settings panel is also at `chrome://extensions` → Details → Extension
options. **Clear** there unsets the URL, so the next new tab asks again.

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
holds the dashboard URL and the last-page snapshot, and the optional
host permission (requested at setup, scoped to the user's own instance)
exists solely to fetch that snapshot with the user's session; no user
data is collected or transmitted anywhere else.

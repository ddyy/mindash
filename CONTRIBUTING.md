# Contributing

mindash is a single Cloudflare Worker with no build step: server-rendered
HTML, CSS/JS served as string constants, and a widget system where each
widget is one self-describing file. Most contributions are widgets.

## Dev loop

```bash
npm install
npm run dev        # wrangler dev on :8787 (local D1/KV state on disk)
npm run check      # tsc --noEmit
npm test           # node:test suite via esbuild
```

The first visit bootstraps the database schema and seeds a showcase
config; /login offers a one-time claim (create the first passkey).

## Adding a widget

A widget is one file: `src/widgets/<type>.ts` (plus an optional sibling
`<type>.css`), registered with one line in `src/widgets/index.ts`.
Everything else - gallery entry, inspector form, validation dispatch,
source-scope rules, CSS bundling - derives from the def. See
`src/widgets/note.ts` (minimal) or `src/widgets/countdown.ts` (small)
for the shape:

1. **Config + parse** - declare the widget's config interface and a
   `parse()` that validates every field. This is the ONLY validation
   layer; the editor deliberately has none to drift.
2. **Behavior** - `fetchData(cfg, env)` if it pulls data (its presence is
   what makes it a pull widget), and `render(data, cfg)` /
   `renderStatic(cfg)` for its card body.
3. **Editor form** - `form:` field descriptors drive the gallery and
   inspector. Give required fields a working `prefill` so the widget
   demos itself when added.
4. **Authority** - list any field that carries fetch/credential authority
   in `sourceFields` (empty array for presentation-only widgets).
5. **Manifest** - add the def to `WIDGETS` in `src/widgets/index.ts` and
   a gallery position in `GALLERY_ORDER`.

## Non-negotiable contracts

PRs that break these will be declined:

- **Escaping by construction**: all markup goes through the `html`
  tagged template; URLs through `safeUrl`; markdown through the safe
  subset renderer in `src/widgets/markdown.ts`. Never return raw strings
  from render.
- **Outbound fetches** only via `safeFetchText`/`safeFetchRaw`
  (https/public-only, bounded bodies and deadlines, redirect rules).
- **Secrets are names, never values**: config stores credential NAMES,
  resolved at fetch time from the encrypted vault (`src/vault.ts`), which
  binds each credential to its widget types and destination origin.
- **No new dependencies** without prior discussion, and no client-side
  frameworks - the dashboard ships ~1KB of first-party JS.
- **Strong consistency lives in D1**; KV is legacy cache only.

## Escape-hazard warning

`src/editor/client.ts` and the other served-JS files are template
literals inside TypeScript: `\n` must be written `\\n`, and regex
escapes degrade silently. After touching them, verify the served output
parses:

```bash
curl -s http://localhost:8787/editor.js | node --check /dev/stdin
```

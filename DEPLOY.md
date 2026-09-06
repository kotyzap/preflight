# Deploying preflight.4xs.dev

Static site, no build step on Cloudflare's side. `dist/` is published verbatim.

## Build

```sh
node build.mjs
```

Writes into `dist/`:

| File | Why it's there |
|---|---|
| `index.html` | The page. Self-contained — no external fonts, scripts or analytics. |
| `rules.json` | The ruleset, served. It's the artefact worth citing, and the same file the scanner reads. CORS-open. |
| `404.html` | Routes strays to the rules. |
| `favicon.svg` | Inline paper-plane mark. |
| `og.svg` / `og.png` | Social card. **PNG is the one that matters** — X and LinkedIn don't render SVG cards. |
| `_headers` | Cloudflare Pages headers: CSP, caching, CORS on `rules.json`. |
| `robots.txt`, `sitemap.xml` | Bookmarkability. |

The build **fails** if anything unexpected is in `dist/`, because that directory
goes live as-is. The pitch deck used to build there and would have shipped to
`/deck.html` without anyone choosing to publish it. It now builds to `build/`,
which is not deployed.

## Cloudflare Pages settings

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `node build.mjs` |
| Build output directory | `dist` |
| Root directory | wherever this repo sits |
| Node version | 18+ (`NODE_VERSION` env var if Pages defaults lower) |

Zero dependencies, so there is no `npm install` step and nothing to audit.

### Direct upload instead

```sh
node build.mjs
npx wrangler pages deploy dist --project-name=preflight
```

## Custom domain

Add `preflight.4xs.dev` in **Pages → Custom domains**. Cloudflare issues the
certificate. If `4xs.dev` is already on Cloudflare DNS the CNAME is created for
you.

## Before the first deploy

- [ ] `node build.mjs` exits 0
- [ ] Open `dist/index.html` locally — tier filters, OS filters and search work; theme toggle persists
- [ ] `dist/deck.html` does **not** exist (the build enforces this)
- [ ] Any figure quoted anywhere else still matches `rules.json` — the page, the deck and the CLI all derive from it

## After it's live

- [ ] `curl -sI https://preflight.4xs.dev/rules.json | grep -i 'content-type\|access-control'` → JSON + `*`
- [ ] Paste the URL into Slack or X and check the card renders the PNG
- [ ] `axis preflight fleet` prints that URL in its footer — confirm it now resolves

## Content-Security-Policy

`_headers` sets a deliberately tight policy:

```
default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';
script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'
```

The page loads nothing external, so anything that tries to is either a bug or a
compromise and should fail loudly. `'unsafe-inline'` is required because the CSS
and the filter script are inlined in the document — that's the trade for a page
with zero external requests. If you later add an external script, this header is
the thing to change first, not to delete.

## Updating the rules

1. Edit `rules.json` — the only place a rule is written.
2. Bump `rulesetVersion`.
3. `node build.mjs` (validates, then renders) and `node deck.mjs`.
4. In axis-cli: `npm run sync:rules`, then `npm test`.
5. Deploy.

The version is printed on the page, in the deck, in `axis preflight` output and
in the JSON, so a stale copy anywhere is visible rather than silent.

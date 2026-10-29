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

## Beta form (`functions/api/beta.js`)

The "Request the beta ACAP" buttons open a form that POSTs to `/api/beta`, a Pages
Function. It emails the request to you through the Cloudflare Email Sending REST
API (no third party, nothing stored). `functions/` sits next to `dist/`, not in it;
both a Git-connected build and `npx wrangler pages deploy dist` (run from the repo
root) pick it up.

One-time setup:

1. **Email → Email Sending**: onboard the sending domain — here `mail.4xs.dev` (adds the DNS records).
2. **Email → Email Routing → Destination addresses**: add and verify `kotyza@gmail.com`
   (sending to a verified destination is free).
3. **My Profile → API Tokens**: create a token with **Email Sending: Edit** on the account.
4. **Workers & Pages → preflight → Settings → Variables and secrets** (Production):

   | Name | Type | Value |
   |---|---|---|
   | `CF_ACCOUNT_ID` | text | your account ID |
   | `CF_EMAIL_TOKEN` | **secret** | the token from step 3 |
   | `BETA_FROM` | text | `preflight@mail.4xs.dev` |
   | `BETA_TO` | text | `kotyza@gmail.com` |

5. Redeploy (variables apply to new deployments only).

Test: submit the form on the live site. On failure the form says so and the
function logs `beta: send failed <status> <body>` (Pages → Deployments → Functions
→ Real-time logs). Spam protection is a honeypot field only; add Turnstile if it
gets abused.

## Ko-fi licence keys (`functions/api/kofi.js`)

A Ko-fi purchase → a signed `PF1.…` key → emailed to the buyer. Same key format and
key pair as `tools/issue-key.mjs`; the ACAP verifies it offline.

1. Ko-fi → Shop → add a digital item "Preflight for OS 13 — network scan licence", €5 (the Ko-fi page is in EUR).
   Assets → **Redirect buyer to a URL**: `https://preflight.4xs.dev/thanks`.
   Its link ends in `/s/<code>`; that `<code>` is `KOFI_SHOP_CODE`, and the whole link
   is `BUY_URL` in `acap/app/html/index.html`.
2. Pages → Settings → Variables and secrets (Production):
   - `KOFI_VERIFICATION_TOKEN` (secret) — Ko-fi → Settings → API → Webhooks.
   - `PREFLIGHT_SIGNING_KEY` (secret) — contents of `~/.preflight/signing.pem`.
   - `KOFI_SHOP_CODE` — from step 1. Without it, any Ko-fi payment ≥ `PREFLIGHT_MIN_AMOUNT`
     (default 5) issues a key, including payments meant for other projects.
   - `CF_ACCOUNT_ID`, `CF_EMAIL_TOKEN`, `BETA_FROM`, `BETA_TO` — already set for the beta form.
   - Bindings → KV namespace → variable `PREFLIGHT_KEYS` (create a namespace, e.g. `preflight-keys`).
     The webhook keeps each key there for an hour under the buyer's email, so `/thanks`
     (`functions/api/key.js`) can show it immediately. Anyone who knows a buyer's email can
     read their key during that hour — accepted at €5. Without the binding: email only.
3. Ko-fi → Settings → API → Webhook URL: `https://preflight.4xs.dev/api/kofi`.
   Ko-fi has one webhook URL per account: if it already points at another project,
   that handler has to forward Preflight orders here (or the other way round).
4. Check: `curl https://preflight.4xs.dev/api/kofi` lists which variables are set.
   Then Ko-fi's "Send test" on the webhook page — a test is a Donation, so it is
   ignored when `KOFI_SHOP_CODE` is set (answer `ignored`), which is correct.

The private key now lives in Cloudflare as well as on the Mac. Anyone with access to
the Pages project's secrets can mint keys; rotating means a new public key in the ACAP
and a new build, and every issued key stops verifying.

The buyer email goes through Cloudflare Email Sending to an arbitrary address. If the
account only allows verified destinations, sending fails with a 500 and Ko-fi retries;
the log (`kofi: send failed`) says so.

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
script-src 'unsafe-inline'; base-uri 'none'; form-action 'self';
connect-src 'self'
```

`form-action` / `connect-src 'self'` exist only for the beta form's POST to `/api/beta`.

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

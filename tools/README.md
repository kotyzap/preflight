# Signing tools

## One-time: create the signing key

Run from the repository root. The private key never passes through a tool or a chat.

```sh
node tools/make-signing-key.mjs
```

Node, not openssl: macOS ships LibreSSL, whose `genpkey` has no ed25519 algorithm
and fails with *"Algorithm ed25519 not found"*. The script refuses to overwrite an
existing key, because replacing it invalidates every licence already issued.

Back up `~/.preflight/signing.pem` where you keep passwords. Losing it means every
future key must be issued under a new public key, which means a new ACAP build, which
means every existing customer's key stops verifying.

## Issue a key

```sh
# from the repository root, not from acap/
PREFLIGHT_SIGNING_KEY=~/.preflight/signing.pem \
  node tools/issue-key.mjs --subject "Acme Security" --expires 2027-12-31
```

Bind a key to specific cameras so it cannot be shared between fleets:

```sh
... --serials B8A44F1234AB,B8A44F5678CD
```

Ed25519, so keys are short enough to paste by hand.

## Signing the .eap with Axis

`acap-build` only ever produces an **unsigned** package. It installs, but the
camera's Apps page shows "This app doesn't have a valid signature" — expected, not
a bug. AXIS OS 13 refuses unsigned applications outright, which is rule A4: this
app must be signed before it can check anyone's fleet for that same problem.

1. Sign in to the Axis Developer/Service Portal.
2. Open the ACAP Application Signing tool.
3. Upload `acap/Preflight_<version>_aarch64.eap`.
4. Download the signed package the portal returns and ship *that* one.

`vendor` in the manifest must be the My Axis **account email** — `kotyza@gmail.com`
— not a display name. A mismatch fails with `ACAP000045`, and because the manifest
is baked in at build time the fix is a rebuild, not an edit.

# Signing tools

## One-time: create the signing key

Run this yourself. The private key must never pass through a tool, a chat, or this
repository.

```sh
mkdir -p ~/.preflight && chmod 700 ~/.preflight
openssl genpkey -algorithm ed25519 -out ~/.preflight/signing.pem
chmod 600 ~/.preflight/signing.pem

# The public half is safe to commit — it only verifies, it cannot sign.
openssl pkey -in ~/.preflight/signing.pem -pubout -out acap/app/src/licence-key.pub
cat acap/app/src/licence-key.pub
```

Back up `~/.preflight/signing.pem` where you keep passwords. Losing it means every
future key must be issued under a new public key, which means a new ACAP build, which
means every existing customer's key stops verifying.

## Issue a key

```sh
PREFLIGHT_SIGNING_KEY=~/.preflight/signing.pem \
  node tools/issue-key.mjs --subject "Acme Security" --expires 2027-12-31
```

Bind a key to specific cameras so it cannot be shared between fleets:

```sh
... --serials B8A44F1234AB,B8A44F5678CD
```

Ed25519, so keys are short enough to paste by hand.

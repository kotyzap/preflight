# Preflight ACAP — subnet upgrade scanner

**Status: complete except licence signing. Not yet built or installed on hardware.**

Install it on **one** camera; it scans the rest of that camera's /24 and reports
which cameras survive an AXIS OS upgrade. Read-only against every camera it finds.

## Done

- `Dockerfile`, `build.sh` — ACAP Native SDK build via Docker, aarch64 for v1.
- `app/manifest.json` — schema 1.7.4, `appName: preflight`, five reverse-proxy CGIs.
- `app/preflight` — launcher (filename must equal appName).
- `app/src/vapix.ts` — dependency-free VAPIX client. Negotiates auth rather than
  assuming digest, which is the bug that made the first bench probe report every
  rule as a false negative. Handles SHA-256 digest and self-signed certificates.
- `app/src/engine.ts` — **the same rule engine axis-cli uses**, copied verbatim.
  It was refactored to have zero imports precisely so both can share it. Do not
  edit this copy; edit it in axis-cli and re-sync.

- `app/src/scan.ts` — reads its own IP and netmask from the OS (no credentials, no
  round-trip), sweeps the /24, probes each host over HTTPS then HTTP. Clamps to a
  /24 even on a wider netmask: a camera is not the right place to sweep a /16, and
  an app that tried would look far more like a network scanner than a compatibility
  check. Includes a dependency-free list.cgi parser handling both the AXIS OS 12
  element form and the OS 10 self-closing form.
- `app/src/bootstrap.ts` — HTTP server on `process.env.HTTP_PORT`, five CGIs,
  settings and results in `PERSISTENT_DATA_PATH` at mode 0600.
- `app/src/licence.ts` — the free/paid line and offline key verification, both in
  one small file because both are business decisions.
- `app/html/index.html` — settings UI, light theme with a toggle.
- `sync.mjs` — pulls engine.ts, report.ts and rules.json from their single homes
  and stamps each with a "synced copy, do not edit here" header.

## Not done

- **Licence signing.** `LICENCE_PUBLIC_KEY` in `licence.ts` is empty, so
  `verifyKey()` currently rejects every key. It fails *closed* on purpose — a build
  that could not verify would otherwise hand the paid tier to everyone. Generate a
  keypair, embed the public half, and write the key-issuing side.
- **Never built.** `./build.sh arm64` has not been run; Docker was not available in
  this session. Expect the usual first-build friction from the gotchas list.
- **Never installed on a camera.** Nothing here has met hardware.

## The free/paid line, and why

Free: which cameras roll back, how many applications are responsible on each, and
every camera-wide finding. Paid: which applications, what to do about each, and the
customer-ready report.

The reasoning is in `licence.ts`. Short version: the CLI is public and does
everything, so gating *information* only inconveniences the buyer who would not
have cloned a repo anyway. What is worth money is the deliverable an integrator
bills for, and not having to set anything up. The free tier still answers the
safety question, which is what preflight.4xs.dev promises.

## Security framing (write this into the UI before release)

An application that installs on one camera and probes the rest of the network is,
structurally, lateral movement, and a security team will read it that way. Get
ahead of it: read-only, no writes, the source is public, and the exact list of
endpoints it touches is documented. This is why the repo is public.

## Build (once complete)

```sh
./build.sh arm64      # or: sh build.sh arm64  on exFAT volumes
```

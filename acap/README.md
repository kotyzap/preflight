# Preflight ACAP — subnet upgrade scanner

**Status: 1.0.0 built and A1/A4-clean. One step left: signing.**
`Preflight_1_0_0_aarch64.eap` is built against ACAP Native SDK **12.11.0** with
manifest **schema 2.2.0**, which is the first schema this SDK ships that accepts
`vendorId` and `compatibleOsVersions`. So the package now declares `11.0`–`13`
and no longer flags itself under its own rule A1 — verified by running the engine
against the app list this package will produce, alongside an app declaring
`11`–`12` to prove the rule still catches one.

A4 is the remaining self-finding, and it is correct: the `.eap` is unsigned, and
AXIS OS 13 refuses unsigned packages. Upload it to the ACAP signing portal and
deploy what comes back.

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

## Open: how does this app declare A1 compatibility?

Rule A1 — the rule this product exists to enforce — says AXIS OS 13 requires
every ACAP to declare which OS majors it supports. **Resolved in 1.0.0.**

The blocker was never the SDK's age but the schema version asked for. SDK 12.6.0
ships schemas up to 1.8.0 only, and neither 1.7.4 nor 1.8.0 permits
`compatibleOsVersions` or `vendorId` — both set `additionalProperties: false` on
`setup`. Reading the schemas out of the image settled in one command what three
passes at the documentation had not:

```sh
docker run --rm --entrypoint sh axisecp/acap-native-sdk:<tag> -c \
  'ls /opt/axis/acapsdk/axis-acap-manifest-tools/schema/schemas/'   # v1, or v1 and v2
```

- 12.6.0 → `v1` only (up to 1.8.0)
- 12.9.0 → `v1` only
- **12.11.0 → `v1` and `v2`**, including 2.2.0

2.2.0 requires `appName`, `architecture`, `compatibleOsVersions`, `runMode`,
`vendor`, `vendorId`, `version`. `vendorId` must match `^[A-Fa-f0-9]{10}$`.

On the declared range: enforcement of `compatibleOsVersions` only begins at AXIS
OS 12.10, so a `min` at or below that changes nothing on older cameras — it is
documentation, and the armv7hf build targets ARTPEC-6/7 hardware running 11.x.
Hence `11.0`. Only 12.11 is bench-verified; nothing below it has been on
hardware, which is worth knowing before widening anything further. `max` is `13`
because that is what rule A1 requires of everyone else.

## Not done

- **Signing the .eap.** The one remaining step, and the one that cannot be
  scripted: upload `Preflight_1_0_0_aarch64.eap` to the ACAP signing portal with
  the My Axis account whose email is in `vendor`, and deploy the file it returns
  rather than the Docker output. A vendor/email mismatch fails with ACAP000045
  and needs a manifest fix and a rebuild — the manifest is baked in at build
  time, so editing the built package does nothing.
- **Advice text in the report.** The settings UI opens each camera with a
  plain-language next action; the customer-facing report still shows findings
  without it. That is backwards — the report is the paid deliverable. It belongs
  in the shared engine so the CLI and the PDF get the same sentences.
- **Scan-time estimate.** 4096 addresses at the default concurrency is roughly
  half an hour on a subnet that drops rather than refuses. The progress bar shows
  where it is but never says how long it will take.

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

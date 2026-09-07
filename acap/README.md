# Preflight ACAP — subnet upgrade scanner

**Status: built, signed keypair in place, installed on the bench Q1656 (OS 12.11).**
Every `/local/preflight/*.cgi` request 404'd on that first package while the static
settings page loaded and the app log showed the server listening on 32554 — so the
proxy hop, not the app. The `reverseProxy` `apiPath`s are now declared bare
(`status`, `settings`, …) with the `.cgi` spellings kept as aliases; Axis's own
working example uses a dotless path, and AXIS OS's Apache already claims `*.cgi`.
Awaiting the rebuild that confirms or refutes it.

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

Rule A1 — the rule this product exists to enforce — says AXIS OS 13 requires every
ACAP to declare which OS majors it supports. **We cannot currently comply**, and
that is a finding worth keeping.

`compatibleOsVersions` in `acapPackageConf.setup` fails the build. The ACAP Native
SDK 12.6.0 validates against manifest **schema 1.7.4**, whose `setup` object sets
`additionalProperties: false` and permits only:

    appId  appName  architecture  embeddedSdkVersion  friendlyName
    runMode  runOptions  user  vendor  vendorUrl  version

No `compatibleOsVersions`, and no `vendorId` either — the signing guidance that
suggested both was wrong for this SDK. Both are removed from the manifest so the
package builds.

The field is real, and the answer is a newer `schemaVersion`, not a newer SDK.
Axis's own current `reverse-proxy-using-fixed-port` example declares:

    "schemaVersion": "2.2.0",
    "vendor": "Axis Communications",
    "vendorId": "1234567890",
    "compatibleOsVersions": [{ "max": "13" }]

— both fields 1.7.4 rejected, accepted under 2.2.0. So bumping `schemaVersion` to
2.2.0 and adding `compatibleOsVersions` plus `vendorId` (`19f191bb41`) should make
this package A1-compliant.

Not done yet, deliberately: a schema bump changes what the *device* accepts at
install time, and it is being held back so it does not confound the reverse-proxy
fix above. Until then the scanner would flag itself, correctly, on an OS 13 camera.

## Not done

- **A1 self-compliance.** See above — the `schemaVersion` 2.2.0 bump.
- **Signing the .eap** through the Axis portal. The package is built but unsigned,
  which means it cannot install on an OS 13 camera at all (rule A4, our own rule).
- **Confirming the reverse-proxy fix** on hardware.
- Note that the *first* installed package predates `licence-key.pub`, so it reports
  `licence verification: DISABLED` and rejects every key. The current build ships
  the public half; `npm run build` prints which of the two you got.

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

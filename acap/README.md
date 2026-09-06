# Preflight ACAP — subnet upgrade scanner

**Status: scaffold, not yet buildable.** Paused mid-build on 2026-09-06 to ship the
web tools first. What exists and what does not is listed below so the next session
does not have to reverse-engineer it.

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

## Not done

- `app/src/scan.ts` — read own IP/netmask, sweep the /24, probe each host.
- `app/src/bootstrap.ts` — HTTP server on `process.env.HTTP_PORT`, the five CGIs,
  persistent settings in `PERSISTENT_DATA_PATH`.
- `app/html/index.html` — settings UI (credentials, scan trigger, results).
- Licence gate: free scan shows verdicts, licence unlocks the detailed report.
  Axis's own ACAP licensing is the intended rail — it is how integrators already buy.
- `sync:engine` / `sync:rules` scripts, and a `rules.json` copy in `app/src/`.

## Security framing (write this into the UI before release)

An application that installs on one camera and probes the rest of the network is,
structurally, lateral movement, and a security team will read it that way. Get
ahead of it: read-only, no writes, the source is public, and the exact list of
endpoints it touches is documented. This is why the repo is public.

## Build (once complete)

```sh
./build.sh arm64      # or: sh build.sh arm64  on exFAT volumes
```

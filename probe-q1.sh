#!/usr/bin/env bash
# Preflight — Q1/Q3 bench probe. READ-ONLY: parameter reads only.
# Nothing is written to the camera, nothing is installed.
#
#   ./probe-q1.sh 192.0.2.10 root 'pass'          # https (self-signed ok)
#   ./probe-q1.sh 192.0.2.10 root 'pass' http
#
# Writes probe-<host>.json next to itself.

set -uo pipefail

HOST="${1:?usage: probe-q1.sh <host> <user> <pass> [http|https]}"
USER="${2:?}"
PASS="${3:?}"
SCHEME="${4:-https}"
BASE="$SCHEME://$HOST"
OUT="$(dirname "$0")/probe-${HOST}.json"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
esc() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }

# ---- 0. work out which auth the device actually accepts --------------------
# Never assume digest. AXIS OS 12.1+ may refuse it entirely.
PROBE_URL="$BASE/axis-cgi/param.cgi?action=list&group=Brand.ProdNbr"
FOUND4=""
Q1_HITS=""
AUTH=""
for MODE in --digest --basic --ntlm --anyauth; do
  RC=$(curl -sS -k "$MODE" -u "$USER:$PASS" -m 12 -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null || echo 000)
  printf '  %-10s %s\n' "${MODE#--}" "$RC"
  [ "$AUTH" = "" ] && [ "$RC" = "200" ] && AUTH="$MODE" && WORKED="$RC"
done

if [ -z "$AUTH" ]; then
  echo
  echo "  No authentication mode succeeded against $BASE." >&2
  echo "  Check credentials, scheme (try 'http' as the 4th argument), and reachability." >&2
  exit 1
fi
echo "  → using ${AUTH#--}"

C=(curl -sS -k "$AUTH" -u "$USER:$PASS" -m 12)
code() { "${C[@]}" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
body() { "${C[@]}" "$1" 2>/dev/null; }

# Any response that is HTML is an error page, not data.
is_err() { printf '%s' "$1" | grep -qi '<html\|Unauthorized\|Error'; }

say "1. Identity"
MODEL=$(body "$BASE/axis-cgi/param.cgi?action=list&group=Brand.ProdNbr")
FW=$(body "$BASE/axis-cgi/param.cgi?action=list&group=Properties.Firmware.Version")
ARCH=$(body "$BASE/axis-cgi/param.cgi?action=list&group=Properties.System.Architecture")
if is_err "$MODEL"; then echo "  identity read failed despite auth succeeding — aborting" >&2; exit 1; fi
printf '  %s\n  %s\n  %s\n' "$MODEL" "$FW" "$ARCH"

say "2. Installed applications"
APPS=$(body "$BASE/axis-cgi/applications/list.cgi")
if is_err "$APPS"; then
  echo "  list.cgi refused for this account — the probe needs an account that can read the app list."
  APPS=""
fi
printf '%s\n' "$APPS"
NAMES=$(printf '%s' "$APPS" | grep -o '<application Name="[^"]*"' | sed 's/.*Name="//;s/"$//')
APPCOUNT=$(printf '%s' "$NAMES" | grep -c . || true)
echo
echo "  applications found: $APPCOUNT"

say "3. Q1 — is a manifest readable WITHOUT pulling the .eap?"
if [ "$APPCOUNT" = "0" ]; then
  echo "  No applications installed — Q1 is UNANSWERED on this camera, not answered NO."
  echo "  Install any ACAP on the bench unit and re-run, or point this at a camera that has one."
else
  echo "  200 = readable · 404 = not there · 401/403 = exists but needs more than read access"
  for APP in $NAMES; do
    echo
    echo "  ── $APP"
    for URL in \
      "$BASE/axis-cgi/applications/getmanifest.cgi?package=$APP" \
      "$BASE/axis-cgi/applications/manifest.cgi?package=$APP" \
      "$BASE/local/$APP/manifest.json" \
      "$BASE/axis-cgi/applications/config.cgi?action=get&name=$APP"
    do
      STATUS=$(code "$URL")
      printf '     %-3s  %s\n' "$STATUS" "${URL#"$BASE"}"
      if [ "$STATUS" = "200" ]; then
        PAYLOAD=$(body "$URL")
        # An ACAP manifest declares acapPackageConf / schemaVersion / compatibleOsVersions.
        # A PWA web manifest declares short_name / icons / start_url — that is NOT a hit.
        if printf '%s' "$PAYLOAD" | grep -qi 'acapPackageConf\|schemaVersion\|compatibleOsVersions'; then
          Q1_HITS="${Q1_HITS}${APP} <- ${URL#"$BASE"}
"
          echo "           ┌ ACAP MANIFEST:"
        else
          echo "           ┌ 200 but NOT an ACAP manifest (looks like a web app manifest) — ignored:"
        fi
        printf '%s' "$PAYLOAD" | head -c 300 | sed 's/^/           │ /'
        echo
      fi
    done
  done
fi

say "4. Does list.cgi already carry what A1/A3 need?"
if [ -n "$APPS" ]; then
  for F in CompatibleOsVersions VersionRange SignatureStatus DeepLearningProcessor Bundled \
           ApplicationID Status Version LicenseName ConfigurationPage; do
    printf '%s' "$APPS" | grep -q "$F" && { echo "     present: $F"; FOUND4="$FOUND4$F "; }
  done
  [ -z "$FOUND4" ] && echo "     none of the compatibility/schema attributes appear"
else
  echo "     (no app list to inspect)"
fi

say "5. Q3 — authentication policy actually in force"
DIGEST=$(curl -sS -k --digest -u "$USER:$PASS" -m 12 -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null || echo 000)
BASIC=$(curl -sS -k --basic  -u "$USER:$PASS" -m 12 -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null || echo 000)
echo "  digest over $SCHEME : $DIGEST"
echo "  basic  over $SCHEME : $BASIC"
body "$BASE/axis-cgi/param.cgi?action=list&group=Network.HTTP" | sed 's/^/  /'
body "$BASE/axis-cgi/param.cgi?action=list&group=System.BoaGroupPolicy" | sed 's/^/  /'

say "6. Parameter-only rules (C1, C3, C4)"
for G in System.BoaGroupPolicy Image.I0.MPEG.SignedVideo.Enabled Network.UPnP.Enabled; do
  R=$(body "$BASE/axis-cgi/param.cgi?action=list&group=$G")
  is_err "$R" && R="(refused)"
  [ -z "$R" ] && R="$G = (absent)"
  printf '  %s\n' "$R"
done

{
  printf '{\n'
  printf '  "host": %s,\n'        "$(printf '%s' "$HOST"   | esc)"
  printf '  "authMode": %s,\n'    "$(printf '%s' "${AUTH#--}" | esc)"
  printf '  "model": %s,\n'       "$(printf '%s' "$MODEL"  | esc)"
  printf '  "firmware": %s,\n'    "$(printf '%s' "$FW"     | esc)"
  printf '  "architecture": %s,\n' "$(printf '%s' "$ARCH"  | esc)"
  printf '  "appCount": %s,\n'    "$APPCOUNT"
  printf '  "applicationsRaw": %s,\n' "$(printf '%s' "$APPS" | esc)"
  printf '  "listCgiFields": %s,\n'   "$(printf '%s' "$FOUND4" | esc)"
  printf '  "q1ManifestHits": %s,\n'  "$(printf '%s' "$Q1_HITS" | esc)"
  printf '  "digestStatus": "%s",\n'  "$DIGEST"
  printf '  "basicStatus": "%s"\n'    "$BASIC"
  printf '}\n'
} > "$OUT"

say "Verdict"
if [ "$APPCOUNT" = "0" ]; then
  echo "  Q1 UNANSWERED — no ACAP installed to test against."
elif [ -n "$Q1_HITS" ]; then
  echo "  Q1 = YES. A manifest is readable read-only. A1/A3/A8 are cheap."
  printf '%s' "$Q1_HITS" | sed 's/^/    /'
else
  echo "  Q1 = NO on $FW. No candidate endpoint returned a manifest."
  [ -n "$FOUND4" ] && echo "  But list.cgi exposes: $FOUND4— check whether that already covers A1/A3."
fi
echo
echo "  Q3: digest=$DIGEST basic=$BASIC over $SCHEME"
echo "  Saved to $OUT"

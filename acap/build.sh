#!/bin/sh
# Build the .eap locally with Docker. Usage: ./build.sh [arm64|armhf|both]
# (On macOS external/exFAT volumes the exec bit may not stick — run `sh build.sh`.)
set -e
cd "$(dirname "$0")"

IMAGE=preflight
VERSION=12.11.0
OS_VERSION=ubuntu24.04
TARGET="${1:-both}"

# $3 = 1 ships the Node runtime gzipped, for cameras whose internal flash cannot
# hold the 79 MB expanded runtime. The .eap download is the same size either way
# (a tar.gz cannot compress an already-gzipped file); what changes is what sits
# on the camera. The small-flash package needs an SD card — see app/preflight.
build_one() {
  ARCH="$1"; TAG="$2"; SMALL="${3:-0}"
  echo "=== Building $ARCH ($TAG) small_flash=$SMALL ==="
  docker build --build-arg ARCH="$ARCH" --build-arg VERSION="$VERSION" \
    --build-arg OS_VERSION="$OS_VERSION" --build-arg SMALL_FLASH="$SMALL" \
    -t "$IMAGE:$TAG" .
  rm -rf "build-$TAG"
  docker cp "$(docker create $IMAGE:$TAG)":/opt/app/. "build-$TAG"
  # Both variants carry the same appName and version, so acap-build gives them
  # the same filename. Rename the small one or the second build silently
  # overwrites the first, and you upload whichever happened to run last.
  for f in "build-$TAG"/*.eap; do
    [ -e "$f" ] || continue
    if [ "$SMALL" = "1" ]; then
      out="$(basename "${f%.eap}")_smallflash.eap"
    else
      out="$(basename "$f")"
    fi
    cp "$f" "./$out" && echo "  -> $out"
  done
}

case "$TARGET" in
  arm64)  build_one aarch64 arm64 0 ;;
  armhf)  build_one armv7hf armhf 0 ;;
  both)   build_one aarch64 arm64 0; build_one armv7hf armhf 0 ;;
  # Small internal flash (CV25 models among them). CV25 is aarch64, so this is
  # the same architecture as the standard arm64 build — only the packaging differs.
  sd|small|smallflash) build_one aarch64 arm64sd 1 ;;
  all)    build_one aarch64 arm64 0; build_one armv7hf armhf 0; build_one aarch64 arm64sd 1 ;;
  *) echo "Usage: $0 [arm64|armhf|both|sd|all]"; exit 1 ;;
esac
echo "Done. .eap files are in $(pwd)"

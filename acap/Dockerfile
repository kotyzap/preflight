# Standalone ACAP build for AXIS OS 11/12 (Native SDK), bundling a Node.js app.
# One architecture per build via --build-arg ARCH (aarch64 | armv7hf).
#   docker build --build-arg ARCH=aarch64 --build-arg VERSION=12.11.0 -t preflight:arm64 .
#   docker cp $(docker create preflight:arm64):/opt/app/. ./build-arm64   # .eap lands here
#
# Replace "preflight" with your appName (also the launcher filename).

ARG ARCH=aarch64
ARG VERSION=12.11.0
# SMALL_FLASH=1 ships the Node runtime gzipped (30 MB on the camera's internal
# flash instead of 79 MB) and decompresses it to the SD card on first start.
# For cameras whose internal flash cannot hold 79 MB — CV25 models among them.
ARG SMALL_FLASH=0
ARG OS_VERSION=ubuntu24.04
FROM --platform=linux/amd64 axisecp/acap-native-sdk:${VERSION}-${ARCH}-${OS_VERSION} AS builder

ARG ARCH
ARG SMALL_FLASH
WORKDIR /opt/app

# Host Node (to run tsc) + fetch the ARM Node runtimes bundled into the .eap.
# Node 18/20 are fine on AXIS OS 11/12 (glibc >= 2.28).
ARG NODE_VERSION=20.11.0
RUN apt-get update && apt-get install -y curl wget xz-utils jq && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    mkdir -p bin && \
    wget -q https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz && \
    tar -xf node-v${NODE_VERSION}-linux-arm64.tar.xz && \
    cp node-v${NODE_VERSION}-linux-arm64/bin/node bin/node-arm64 && \
    wget -q https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-armv7l.tar.xz && \
    tar -xf node-v${NODE_VERSION}-linux-armv7l.tar.xz && \
    cp node-v${NODE_VERSION}-linux-armv7l/bin/node bin/node-armhf && \
    rm -rf node-v${NODE_VERSION}-linux-*

COPY app/ /opt/app/

# Production deps + compile TypeScript -> dist/
RUN npm install && npm run build && npm prune --omit=dev

# GOTCHA #1: sourcing environment-setup* exports its own ARCH (e.g. "arm64"),
# clobbering the build arg. Capture TARGET_ARCH BEFORE sourcing and key off it.
RUN TARGET_ARCH="$ARCH" && SMALL="${SMALL_FLASH:-0}" && \
    . /opt/axis/acapsdk/environment-setup* && \
    echo "Build TARGET_ARCH=[$TARGET_ARCH] SMALL_FLASH=[$SMALL]" && \
    case "$TARGET_ARCH" in \
      aarch64) rm -f bin/node-armhf; ${STRIP} bin/node-arm64 2>/dev/null || true ;; \
      armv7hf) rm -f bin/node-arm64; ${STRIP} bin/node-armhf 2>/dev/null || true ;; \
      *) echo "Unknown TARGET_ARCH=[$TARGET_ARCH]" >&2; exit 1 ;; \
    esac && \
    if [ "$SMALL" = "1" ]; then \
      echo "small-flash: compressing the runtime"; \
      ls -l bin/; gzip -9 bin/node-*; ls -l bin/; \
    fi && \
    sed -i "s/\"architecture\": \"[^\"]*\"/\"architecture\": \"$TARGET_ARCH\"/" manifest.json && \
    chmod +x preflight 2>/dev/null; \
    echo "=== active manifest.json ===" && cat manifest.json

# Build the .eap. GOTCHA #5: html/ is auto-included — do NOT pass it via -a.
# Add only the dirs acap-build won't include on its own.
RUN . /opt/axis/acapsdk/environment-setup* && \
    grep architecture manifest.json && \
    find . -name '.DS_Store' -delete && \
    if [ -n "$(find node_modules -type f 2>/dev/null | head -1)" ]; then EXTRA="-a node_modules"; else EXTRA=""; rm -rf node_modules; fi && \
    acap-build . -a dist -a bin $EXTRA && \
    echo "=== built .eap ===" && ls -la *.eap && \
    tar tzf *.eap 2>/dev/null | sed -n '1,40p'

# Headless Chromium + CDP endpoint for browser automation.
#
# Architecture (see /share/scratchpad/opencode/imported/PLAYWRIGHT-MCP.md):
# the Playwright MCP bridges live in other containers (opencode, litellm) and
# connect over CDP; this add-on only needs chromium itself plus nginx for the
# Host/ws://localhost rewrite, supervised by s6.
#
# NOTE: FROM is hardcoded instead of using BUILD_FROM/build.yaml because both
# the HA Supervisor's build_from regex and the single-segment image path
# convention reject multi-segment registry images like "ghcr.io/...". CI
# builds this with a plain docker build, so no build.yaml is needed.
#
# Built on the Home Assistant Debian base (s6-overlay + bashio + jq/curl).
# This replaces mcr.microsoft.com/playwright:v1.63.0-noble (~2.5 GB: Ubuntu
# plus Chromium/Firefox/WebKit): only Chromium is ever launched, so the image
# installs Debian's chromium directly and tracks its security updates through
# Debian. CDP is stable, so the MCP bridges do not need to match the browser
# version.
FROM ghcr.io/home-assistant/base-debian:trixie

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium \
        nginx \
        fonts-liberation \
        fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

COPY rootfs /
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 9222

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:9222/json/version || exit 1

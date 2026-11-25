# ==============================================================================
# HA MCP add-on: ha-mcp-server (from the OpenCode add-on) on its own, serving
# the Home Assistant toolset over streamable HTTP on 8927 for agents that run
# elsewhere. Tool profile `deployed`: everything except the tools that write
# configuration files, which live in git and are deployed on merge.
#
# The Supervisor API, hab and zigporter only work from inside Home Assistant,
# which is why this part stays an add-on.
#
# Built on Home Assistant's Debian base (s6 + Bashio) with only what the server
# runs: Node, hab, zigporter, and Chromium for the screenshot tool.
# ==============================================================================

ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie
ARG NODE_VERSION=24.21.0

# Home Assistant publishes no Node-specific Debian base: copy an exact official
# Node toolchain into its base instead.
FROM node:${NODE_VERSION}-trixie-slim AS node-runtime

## hab CLI from source (pinned release), cross-compiled on the build platform
FROM --platform=$BUILDPLATFORM golang:1.27-trixie AS hab-builder

# renovate: datasource=github-tags depName=balloob/home-assistant-build-cli
ARG HAB_VERSION=1.6.4
ARG TARGETARCH
RUN git clone --depth 1 --branch "${HAB_VERSION}" https://github.com/balloob/home-assistant-build-cli.git /src
WORKDIR /src
RUN case "${TARGETARCH}" in amd64|arm64) ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH:-unset}" >&2; exit 1;; esac \
    && GOARCH=${TARGETARCH} \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /hab .

FROM ${BUILD_FROM}

ARG BUILD_VERSION
ARG BUILD_ARCH
ARG NODE_VERSION

ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && test "$(node --version)" = "v${NODE_VERSION}"

COPY --from=hab-builder /hab /usr/local/bin/hab

# Chromium for the screenshot tool (puppeteer-core).
# python3-venv for zigporter (below); curl for the health check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation python3 python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/chromium

# zigporter in its own virtualenv: Zigbee cascade renames and inspection
RUN python3 -m venv /opt/zigporter-venv \
    && /opt/zigporter-venv/bin/pip install --no-cache-dir zigporter \
    && ln -s /opt/zigporter-venv/bin/zigporter /usr/local/bin/zigporter \
    && zigporter --version >/dev/null
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Dependencies first: code changes must not invalidate the npm layer.
COPY rootfs/opt/ha-mcp-server/package*.json /opt/ha-mcp-server/
RUN cd /opt/ha-mcp-server \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && find node_modules -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

COPY rootfs /

RUN chmod +x /etc/s6-overlay/s6-rc.d/init-ha-mcp/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-mcp-http/run \
    && mkdir -p /data

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:8927/health > /dev/null || exit 1

LABEL \
    io.hass.name="HA MCP" \
    io.hass.description="Home Assistant MCP server over HTTP, without configuration writes" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

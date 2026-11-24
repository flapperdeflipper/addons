# ==============================================================================
# HA MCP add-on: ha-mcp-server (from the OpenCode add-on) on its own, serving
# the Home Assistant toolset over streamable HTTP on 8927 for agents that run
# elsewhere. Tool profile `deployed`: everything except the tools that write
# configuration files, which live in git and are deployed on merge.
#
# The Supervisor API, hab and zigporter only work from inside Home Assistant,
# which is why this part stays an add-on.
# ==============================================================================

ARG AGENT_BASE=ghcr.io/flapperdeflipper/agent-base:1.4.0

FROM ${AGENT_BASE}

ARG BUILD_VERSION
ARG BUILD_ARCH

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

# Chromium for the screenshot tool (puppeteer-core).
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/chromium
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

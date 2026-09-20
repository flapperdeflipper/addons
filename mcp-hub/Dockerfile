# ==============================================================================
# MCP Hub add-on - one shared MCP server process per tool set, served over
# streamable HTTP for every agent on the host (OpenCode sessions, LiteLLM
# gateway, ...), replacing per-session stdio spawns that cost ~260 MB each.
#
# Lean by design: no agent-base toolchain, no s6 - a plain pinned Node image
# running the gateway in server/src/gateway.js. The FROM line is hardcoded
# (like playwright-browser) because no build_from matrix is needed for a
# single-arch Node image; no build.yaml required.
# ==============================================================================

# Global ARG (available in FROM instructions)
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

## Main add-on image
FROM ${NODE_IMAGE}

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH

RUN case "${BUILD_ARCH}" in amd64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

# curl is only used by the container healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifest first for better layer caching; changes to server
# code must not invalidate the npm install layer.
COPY rootfs/opt/mcp-hub/package*.json /opt/mcp-hub/

# @playwright/mcp is pinned exactly (0.0.80) - it is the version the
# playwright-browser add-on setup is tested against; a floating tag could
# change tool schemas under running sessions.
RUN cd /opt/mcp-hub \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && find /opt/mcp-hub/node_modules -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

# Copy root filesystem (gateway code, entrypoint)
COPY rootfs /

RUN chmod +x /run.sh

EXPOSE 8930/tcp

# Health check - unauthenticated liveness endpoint; per-server health is
# included in the payload so a crashed playwright child is visible.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:8930/healthz || exit 1

# Labels for Home Assistant
LABEL \
    io.hass.name="MCP Hub" \
    io.hass.description="Shared MCP servers over HTTP for agents on this host" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

CMD ["/run.sh"]

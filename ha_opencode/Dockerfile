# ==============================================================================
# OpenCode add-on — the HA MCP/LSP servers and s6 services layered on the
# shared agent-base image.
#
# The toolchain (exact Node runtime, certified OpenCode pin, hab, zigporter,
# ttyd + patched ingress page, yq, op/cosign CLIs, unix toolset, skills
# snapshot) lives in flapperdeflipper/agent-base and is shared with the
# OpenChamber and Terminal add-ons. Bump AGENT_BASE to pick up toolchain
# changes; releases of agent-base open that bump as a PR automatically.
# ==============================================================================

# Global ARG (available in FROM instructions)
ARG AGENT_BASE=ghcr.io/flapperdeflipper/agent-base:1.1.0

## Main add-on image
FROM ${AGENT_BASE}

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH
# Which release channel this image is. The two add-on folders ship identical
# rootfs trees — promoting beta to stable is a straight copy of rootfs/ — so
# nothing inside rootfs/ may name a channel. This arg is the single point where
# the two builds differ, and the workflows pass it explicitly.
ARG ADDON_CHANNEL=stable

# Carried into every process in the container. Shell code reads it via
# /usr/local/lib/opencode/channel.sh; Node code reads process.env.ADDON_CHANNEL.
ENV ADDON_CHANNEL=${ADDON_CHANNEL}

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

# Chromium for the MCP screenshot tool (puppeteer-core). This is deliberately
# the only toolchain piece installed here rather than in agent-base: only this
# add-on's screenshot tool launches a local browser, so OpenChamber and
# Terminal do not ship the ~590 MB Chromium stack. agent-base carried it until
# 1.0.0; from agent-base 1.1.0 this layer is the single chromium owner.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/chromium

# Browser path for puppeteer-core (screenshot MCP tool)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# The certified runtime comes from agent-base. Assert the image really
# inherited the certified build: this catches a base image built from a fork
# or a broken pin without failing every later layer with a confusing error.
RUN test "$(opencode --version)" = "$(cat /usr/local/share/opencode-certified-version)"

# Copy package.json files first for better layer caching
# Changes to server code won't invalidate npm install cache
COPY rootfs/opt/ha-mcp-server/package*.json /opt/ha-mcp-server/
COPY rootfs/opt/ha-lsp-server/package*.json /opt/ha-lsp-server/

# Install MCP and LSP dependencies in parallel
RUN (cd /opt/ha-mcp-server && npm install --omit=dev --no-audit --no-fund) & \
    (cd /opt/ha-lsp-server && npm install --omit=dev --no-audit --no-fund) & \
    wait \
    && npm cache clean --force \
    && find /opt/ha-mcp-server/node_modules /opt/ha-lsp-server/node_modules \
        -type f \( -name '*.d.ts' -o -name '*.map' \) -delete \
    && test "$(opencode --version)" = "$(cat /usr/local/share/opencode-certified-version)"

# Copy root filesystem (server code, scripts, etc.)
COPY rootfs /

# Make scripts executable and create runtime directories
RUN chmod +x /usr/local/bin/* \
    && chmod +x /etc/s6-overlay/s6-rc.d/init-opencode/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-server/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-mcp-http/run \
    && mkdir -p /data/.local/share/opencode /data/.config/opencode

# Set working directory to HA config (mounted at runtime)
WORKDIR /homeassistant

# Health check - verify the active ingress service is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:8099/ > /dev/null || exit 1

# Labels for Home Assistant
LABEL \
    io.hass.name="OpenCode" \
    io.hass.description="AI coding agent for editing Home Assistant configuration" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

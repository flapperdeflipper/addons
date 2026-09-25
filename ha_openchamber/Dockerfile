# ==============================================================================
# OpenChamber add-on — the OpenChamber web UI, its ingress patch and s6
# services, layered on the shared agent-base image.
#
# The toolchain (exact Node runtime, certified OpenCode CLI, unix toolset,
# ttyd ingress page, hab, zigporter, ...) lives in flapperdeflipper/agent-base
# and is shared with the ha_opencode and terminal add-ons. Bump AGENT_BASE to
# pick up toolchain changes; releases of agent-base open that bump as a PR
# automatically.
# ==============================================================================

# Global ARG (available in FROM instructions)
ARG AGENT_BASE=ghcr.io/flapperdeflipper/agent-base:1.1.1

## OpenChamber add-on image
FROM ${AGENT_BASE}

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH
# Pinned OpenChamber release. Hard pin, never a range or a dist-tag: the bundle
# is Ingress-patched at build time (see /opt/openchamber/patch-ingress.js), so
# it changes only through a tested add-on release. build.yaml carries the same
# value and is what CI reads.
ARG OPENCHAMBER_VERSION=1.24.2

# Environment for better Node.js performance
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

# Install the pinned OpenChamber web UI globally. The trailing assertion fails
# the build when the resolved package is not the pinned one, and the version
# is recorded on disk for runtime reference. The OpenCode CLI comes from
# agent-base; the certified-version assertion guards against a base built from
# a fork. The base ships the build toolchain, so native fallback builds for
# OpenChamber dependencies work without a compiler dance here.
RUN npm install -g --omit=dev --omit=peer --no-audit --no-fund \
        @openchamber/web@${OPENCHAMBER_VERSION} \
    && npm cache clean --force \
    && INSTALLED=$(node -e "console.log(require('/usr/local/lib/node_modules/@openchamber/web/package.json').version)") \
    && if [ "${INSTALLED}" != "${OPENCHAMBER_VERSION}" ]; then \
        echo "OPENCHAMBER_VERSION is ${OPENCHAMBER_VERSION} but the installed package is ${INSTALLED}" >&2; \
        exit 1; \
    fi \
    && test "$(opencode --version)" = "$(cat /usr/local/share/opencode-certified-version)" \
    && find /usr/local/lib/node_modules/@openchamber -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.pdb' \) -delete \
    && printf '%s\n' "${OPENCHAMBER_VERSION}" > /usr/local/share/openchamber-pinned-version \
    && test "$(openchamber --version 2>/dev/null | grep -o "${OPENCHAMBER_VERSION}")" = "${OPENCHAMBER_VERSION}"

# Copy root filesystem (ingress proxy, agent MCP server, s6 service definitions)
COPY rootfs /

# Agent MCP server dependencies, installed from the checked-in package.json so
# the pin lives in version control (bump with version: in config.yaml). The
# server lives inside this prefix: ESM imports do not use NODE_PATH, so
# /opt/openchamber-mcp/server.mjs resolves the SDK from its sibling node_modules.
RUN npm install --prefix /opt/openchamber-mcp --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# OpenChamber is a generic root-hosted web app. Patch the pinned bundle so its
# static assets and runtime API URLs resolve under Home Assistant's Ingress path.
RUN node /opt/openchamber/patch-ingress.js

# Make scripts executable and create runtime directories
RUN chmod +x /usr/local/bin/* \
    && chmod +x /opt/openchamber/patch-ingress.js \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber-ingress/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber-lan/run \
    && mkdir -p /data/.config/openchamber /data/.local/share

# Working directory matches the OpenCode add-on (mounted at runtime)
WORKDIR /homeassistant

# Health check - the Ingress proxy answers on loopback (allowlisted) once the
# OpenChamber server is up; a failure means the add-on is genuinely not serving.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:8099/ > /dev/null || exit 1

# Labels for Home Assistant
LABEL \
    io.hass.name="OpenChamber" \
    io.hass.description="Browser UI for OpenCode conversations" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}"

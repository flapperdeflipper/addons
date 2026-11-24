# ==============================================================================
# OpenCode TUI add-on: OpenCode's terminal interface in an Ingress panel,
# attached to a remote OpenCode server. The sessions, their tools and files
# live on the server; this container only draws the interface.
#
# agent-base carries the OpenCode CLI, ttyd with the patched Ingress page and
# tmux; this add-on adds one s6 service and the session script.
# ==============================================================================

ARG AGENT_BASE=ghcr.io/flapperdeflipper/agent-base:1.4.0

FROM ${AGENT_BASE}

ARG BUILD_VERSION
ARG BUILD_ARCH

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

COPY rootfs /

RUN chmod +x /etc/s6-overlay/s6-rc.d/opencode-tui/run \
    && chmod +x /usr/local/bin/opencode-tui-session \
    && mkdir -p /data

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:8099/ > /dev/null || exit 1

LABEL \
    io.hass.name="OpenCode TUI" \
    io.hass.description="OpenCode's terminal interface attached to a remote OpenCode server" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

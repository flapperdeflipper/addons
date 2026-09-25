# ==============================================================================
# Terminal add-on — a personal shell on the shared agent-base image.
#
# agent-base (flapperdeflipper/agent-base) carries the full toolchain the
# terminal used to install itself: node 24 + npm, gh/glab, jq, yq, tmux, ttyd
# (plus the patched index page at /opt/ttyd/index.html), openssh-client,
# chromium, python3 + venv, rsync, hab, zigporter, the 1Password CLI, the
# opencode runtime, and the merged workstation package set (vim, neovim, stow,
# fzf, bat, shellcheck, the lot). Bump AGENT_BASE to pick up toolchain changes;
# releases of agent-base open that bump as a PR automatically.
#
# The base ships no add-on services, so this image only adds the terminal s6
# services — nothing to disable or remove.
# ==============================================================================

# Global ARG (available in FROM instructions)
ARG AGENT_BASE=ghcr.io/flapperdeflipper/agent-base:1.1.1

FROM ${AGENT_BASE}

ARG BUILD_VERSION
ARG BUILD_ARCH

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

# Our rootfs: the init and terminal s6 services plus helper scripts
COPY rootfs /

RUN chmod +x /etc/s6-overlay/s6-rc.d/init-terminal/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/terminal/run \
    && chmod +x /usr/local/bin/dotfiles-sync \
    && chmod +x /usr/local/bin/terminal-session.sh \
    && mkdir -p /data

# Sessions start in the Home Assistant configuration directory (mounted at
# runtime by the homeassistant_config map)
WORKDIR /homeassistant

# Health check - ttyd ingress service answering on the add-on port
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:7681/ > /dev/null || exit 1

# Labels for Home Assistant
LABEL \
    io.hass.name="Terminal" \
    io.hass.description="Personal bash and vim terminal with dotfiles and toolset" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

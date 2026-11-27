# ==============================================================================
# Terminal add-on — a personal shell with the workstation toolset, Claude Code,
# and OpenCode's terminal interface for the OpenCode server on another host.
#
# Self-contained since 2.0.0 (the toolchain used to come from the separate
# agent-base image): the exact Node toolchain, the CLI/unix toolset, hab and
# zigporter for Home Assistant, ttyd with a patched ingress page, yq, cosign,
# Claude Code, and the OpenCode client. Nothing auto-updates inside the image:
# every tool is a hard pin, bumped by a reviewed PR.
#
# The Home Assistant s6/Bashio base is the final stage so the add-on stays
# Supervisor-compatible.
# ==============================================================================

# Global ARGs (available in FROM instructions)
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie
ARG NODE_VERSION=24.21.0

# Home Assistant does not publish a Node-specific Debian base. Keep its s6 and
# Bashio runtime as the final base, and copy an exact official Node toolchain in.
FROM node:${NODE_VERSION}-trixie-slim AS node-runtime

## Build hab CLI from source (pinned release)
# Pinned to the build host's platform: Go cross-compiles via GOARCH below, so
# this stage never needs to run under emulation.
FROM --platform=$BUILDPLATFORM golang:1.27-trixie AS hab-builder

# renovate: datasource=github-tags depName=balloob/home-assistant-build-cli
ARG HAB_VERSION=1.10.0
ARG TARGETARCH
RUN git clone --depth 1 --branch "${HAB_VERSION}" https://github.com/balloob/home-assistant-build-cli.git /src
WORKDIR /src

RUN case "${TARGETARCH}" in amd64|arm64) ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH:-unset}" >&2; exit 1;; esac \
    && GOARCH=${TARGETARCH} \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /hab .

## Main image
FROM ${BUILD_FROM}

ARG BUILD_VERSION
ARG BUILD_ARCH
ARG TARGETARCH
ARG NODE_VERSION
# OpenCode client (npm @opencode/cli). Must match the OpenCode server it
# attaches to (llm-suite on hd): bump both together.
# renovate: datasource=npm depName=@opencode/cli
ARG OPENCODE_VERSION=2.4.2
# Claude Code (npm @anthropic-ai/claude-code; the package installs the native
# binary). Updates are disabled at runtime (DISABLE_UPDATES below).
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.332
# Lens plugin for OpenCode (BerriAI/litellm-lens-plugins, opencode/), pinned
# to a commit: the repo has no releases or npm package. Bump by hand.
ARG LITELLM_LENS_PLUGINS_REF=49ba6ebd9cb29e162b06423cc661ff47740a0f50
# renovate: datasource=github-releases depName=tsl0922/ttyd
ARG TTYD_VERSION=1.7.7
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=v4.54.3
# renovate: datasource=github-releases depName=sigstore/cosign
ARG COSIGN_VERSION=v3.1.6

# Node and npm quiet, both agents' self-updaters off: the image is the version.
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    DISABLE_UPDATES=1 \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=true

# HA config dir helpers (hasecret et al.) live in /homeassistant/bin, mounted
# at runtime; prepend it so every shell resolves them unqualified.
ENV PATH="/homeassistant/bin:${PATH}"

RUN case "${TARGETARCH}" in amd64|arm64) ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH:-unset}" >&2; exit 1;; esac

# The exact Node runtime, without replacing Home Assistant's base image. npm is
# shipped with the official Node image.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s node /usr/local/bin/nodejs

# Curated toolset: editors, shells and completions, archive/compression, build
# tools (native npm fallback builds need gcc/g++/make + python3), python venv
# tooling, imagemagick and ffmpeg for media work, and the interactive unix
# toolset (fzf, bat, zoxide, ...). One-shot heavyweight tools (awscli, nmap,
# rclone, ...) and chromium are deliberately left out. Apt skips what the base
# already ships.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        bash-completion \
        bat \
        binutils \
        bubblewrap \
        bzip2 \
        ca-certificates \
        coreutils \
        curl \
        file \
        findutils \
        ffmpeg \
        fzf \
        g++ \
        gawk \
        gcc \
        gettext \
        gh \
        git \
        gnupg \
        gnupg2 \
        graphviz \
        grep \
        highlight \
        htop \
        imagemagick \
        jq \
        libatomic1 \
        libffi-dev \
        libpcre2-dev \
        libpq-dev \
        libyaml-dev \
        make \
        ncdu \
        netcat-openbsd \
        openssh-client \
        openssl \
        p7zip \
        pigz \
        prettyping \
        procps \
        python3 \
        python3-venv \
        python3-virtualenv \
        python3-virtualenvwrapper \
        python3-yaml \
        ripgrep \
        rsync \
        shellcheck \
        sqlite3 \
        stow \
        sudo \
        tmux \
        tree \
        unzip \
        vim \
        neovim \
        wget \
        xz-utils \
        yamllint \
        zoxide \
    && command -v ssh >/dev/null \
    && command -v gh >/dev/null \
    && command -v rg >/dev/null \
    && test "$(command -v node)" = /usr/local/bin/node \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && npm --version >/dev/null \
    && rm -rf /var/lib/apt/lists/*

# ttyd (not in Debian): the web terminal behind Home Assistant Ingress
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ARCH}" -o /usr/bin/ttyd \
    && chmod +x /usr/bin/ttyd \
    && ttyd --version | grep -q "${TTYD_VERSION}"

# yq (mikefarah): YAML that tolerates Home Assistant's custom tags. The version
# check fails the build on a truncated download or a colliding "yq".
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version | grep -q mikefarah

# cosign (sigstore): verify the published add-on images
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -fsSL "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${ARCH}" -o /usr/local/bin/cosign \
    && chmod +x /usr/local/bin/cosign \
    && cosign version 2>/dev/null | grep -q "GitVersion:.*${COSIGN_VERSION}"

# hab, built from source above: Home Assistant admin over REST/WebSocket
COPY --from=hab-builder /hab /usr/local/bin/hab

# zigporter in its own virtualenv: Zigbee cascade renames and inspection
RUN python3 -m venv /opt/zigporter-venv \
    && /opt/zigporter-venv/bin/pip install --no-cache-dir zigporter \
    && ln -s /opt/zigporter-venv/bin/zigporter /usr/local/bin/zigporter

# OpenCode client, Claude Code and Prettier (YAML formatting for HA files).
# The assertions fail the build when npm resolved anything but the pins.
RUN npm install -g --omit=dev --omit=peer --no-audit --no-fund \
        @opencode/cli@${OPENCODE_VERSION} \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
        prettier \
    && npm cache clean --force \
    && INSTALLED=$(node -e "console.log(require('/usr/local/lib/node_modules/@opencode/cli/package.json').version)") \
    && if [ "${INSTALLED}" != "${OPENCODE_VERSION}" ]; then \
        echo "OPENCODE_VERSION is ${OPENCODE_VERSION} but npm installed ${INSTALLED}" >&2; exit 1; \
    fi \
    && if [ "${TARGETARCH}" = "arm64" ]; then \
        find /usr/local/lib/node_modules/@opencode -mindepth 1 -maxdepth 1 -type d \
            ! -name "cli" ! -name "cli-linux-arm64" -exec rm -rf {} +; \
    else \
        find /usr/local/lib/node_modules/@opencode -mindepth 1 -maxdepth 1 -type d \
            ! -name "cli" ! -name "cli-linux-x64" ! -name "cli-linux-x64-baseline" -exec rm -rf {} +; \
    fi \
    && find /usr/local/lib/node_modules -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.pdb' \) -delete \
    && test "$(opencode --version)" = "opencode v${OPENCODE_VERSION}" \
    && claude --version | grep -q "^${CLAUDE_CODE_VERSION} "

# Lens plugin for a local OpenCode; init-terminal links it into OpenCode's
# plugin directory. It stays off until both LITELLM_LENS_OPENCODE_* are set.
RUN npm install -g --omit=dev --no-audit --no-fund \
        "git+https://github.com/BerriAI/litellm-lens-plugins.git#${LITELLM_LENS_PLUGINS_REF}" \
    && npm cache clean --force \
    && test -f /usr/local/lib/node_modules/litellm-lens-plugins/opencode/index.js

# Our rootfs: s6 services, helper scripts, profile.d wrappers, the ttyd page
COPY rootfs /

# Build the custom ttyd index page (served via -I at runtime): ttyd's page is
# compiled into the binary, so dump it from a briefly-running instance and
# inject the browser-side fixes for clipboard, touch scrolling and iframe
# auto-fit. The injector fails the build on an unexpected layout.
RUN set -e; \
    ttyd -p 18099 -i lo bash & \
    TTYD_PID=$!; \
    ok=0; \
    for i in $(seq 1 50); do \
        if curl -fsS -o /tmp/ttyd-index.html http://127.0.0.1:18099/; then ok=1; break; fi; \
        sleep 0.2; \
    done; \
    kill "$TTYD_PID"; \
    [ "$ok" = "1" ]; \
    python3 /opt/ttyd/inject-clipboard.py /tmp/ttyd-index.html /opt/ttyd/index.html /opt/ttyd/clipboard.js /opt/ttyd/touch-scroll.js /opt/ttyd/resize-fit.js; \
    rm -f /tmp/ttyd-index.html

RUN chmod +x /etc/s6-overlay/s6-rc.d/init-terminal/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/terminal/run \
    && chmod +x /usr/local/bin/dotfiles-sync \
    && chmod +x /usr/local/bin/terminal-session.sh \
    && chmod +x /usr/local/bin/opencode-hd \
    && chmod +x /etc/profile.d/hab-esphome.sh \
    && chmod +x /etc/profile.d/zigporter-z2m.sh \
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
    io.hass.description="Personal terminal with dotfiles, toolset, Claude Code and OpenCode" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

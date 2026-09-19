# Global ARGs (available in FROM instructions)
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie
ARG NODE_VERSION=24.21.0

# Home Assistant does not publish a Node-specific Debian base. Keep its s6 and
# Bashio runtime as the final base, and copy an exact official Node toolchain in.
FROM node:${NODE_VERSION}-trixie-slim AS node-runtime

## Stage 2: OpenChamber add-on image
FROM $BUILD_FROM

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH
ARG NODE_VERSION
# Pinned OpenChamber release. Hard pin, never a range or a dist-tag: the bundle
# is Ingress-patched at build time (see /opt/openchamber/patch-ingress.js), so
# it changes only through a tested add-on release. build.yaml carries the same
# value and is what CI reads.
ARG OPENCHAMBER_VERSION=1.24.1

# Pinned OpenCode CLI, the same certified pin as the OpenCode add-on
# (ha_opencode/build.yaml). OpenChamber's server resolves an `opencode` binary
# at startup even in external-server mode (OPENCODE_SKIP_START), so the image
# ships the real CLI on PATH instead of relying on workarounds.
ARG OPENCODE_VERSION=1.18.31

# Environment for better Node.js performance
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

# Install the exact supported Node runtime without replacing Home Assistant's
# Supervisor-compatible base image. npm is shipped with the official Node image.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s node /usr/local/bin/nodejs

# Install system dependencies in a single layer
# - ca-certificates/curl: Supervisor health check and the OpenCode server probe
# - bzip2: Required by system tar to extract OpenChamber voice models
# - libatomic1: runtime library expected by the Node toolchain on this base
# - git: the sessions UI shells out to the git binary via simple-git for
#   branch/worktree info of the OpenCode workspace
# - g++/make: native fallback builds for OpenChamber dependencies on all
#   arches; installed only while npm installs and purged right after
# - everything else: the interactive toolset for the OpenChamber terminal
#   (editors, archives, process/network inspection, Python venv tooling);
#   the -dev packages are headers only, no compiler stays installed
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        awscli \
        bash \
        bats \
        bats-assert \
        bats-file \
        bats-support \
        bc \
        bubblewrap \
        bzip2 \
        ca-certificates \
        coreutils \
        curl \
        direnv \
        file \
        findutils \
        fzf \
        g++ \
        gawk \
        gettext \
        git \
        grc \
        highlight \
        ipcalc \
        jo \
        jq \
        libatomic1 \
        libffi-dev \
        libpcre2-dev \
        libpq-dev \
        libtool \
        libyaml-dev \
        make \
        moreutils \
        ncdu \
        netcat-openbsd \
        openssl \
        p7zip \
        pigz \
        procps \
        progress \
        psutils \
        python3 \
        python3-virtualenv \
        python3-virtualenvwrapper \
        sqlite3 \
        sudo \
        telnet \
        tree \
        unzip \
        vim \
        wget \
        zoxide \
    && rm -rf /var/lib/apt/lists/*

# Install the pinned OpenChamber web UI globally. The trailing assertion fails
# the build when the resolved package is not the pinned one, and the version
# is recorded on disk for runtime reference.
RUN npm install -g --omit=dev --omit=peer --no-audit --no-fund \
        @openchamber/web@${OPENCHAMBER_VERSION} \
        opencode-ai@${OPENCODE_VERSION} \
    && npm cache clean --force \
    && apt-get purge -y --auto-remove g++ make \
    && INSTALLED=$(node -e "console.log(require('/usr/local/lib/node_modules/@openchamber/web/package.json').version)") \
    && if [ "${INSTALLED}" != "${OPENCHAMBER_VERSION}" ]; then \
        echo "OPENCHAMBER_VERSION is ${OPENCHAMBER_VERSION} but the installed package is ${INSTALLED}" >&2; \
        exit 1; \
    fi \
    && OPENCODE_INSTALLED=$(node -e "console.log(require('/usr/local/lib/node_modules/opencode-ai/package.json').version)") \
    && if [ "${OPENCODE_INSTALLED}" != "${OPENCODE_VERSION}" ]; then \
        echo "OPENCODE_VERSION is ${OPENCODE_VERSION} but the installed CLI is ${OPENCODE_INSTALLED}" >&2; \
        exit 1; \
    fi \
    && OPENCODE_ARCH=$([ "${BUILD_ARCH}" = "aarch64" ] && echo "arm64" || echo "x64") \
    && if [ "${OPENCODE_ARCH}" = "arm64" ]; then \
        find /usr/local/lib/node_modules/opencode-ai/node_modules -mindepth 1 -maxdepth 1 -type d \
            ! -name "opencode-linux-arm64" -exec rm -rf {} +; \
    else \
        find /usr/local/lib/node_modules/opencode-ai/node_modules -mindepth 1 -maxdepth 1 -type d \
            ! -name "opencode-linux-x64" ! -name "opencode-linux-x64-baseline" -exec rm -rf {} +; \
    fi \
    && find /usr/local/lib/node_modules -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.pdb' \) -delete \
    && printf '%s\n' "${OPENCHAMBER_VERSION}" > /usr/local/share/openchamber-pinned-version \
    && test "$(openchamber --version 2>/dev/null | grep -o "${OPENCHAMBER_VERSION}")" = "${OPENCHAMBER_VERSION}" \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}"

# Copy root filesystem (ingress proxy, s6 service definitions)
COPY rootfs /

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

# ==============================================================================
# Terminal add-on — a personal shell layered on top of the OpenCode add-on
# image.
#
# Basing on the published OpenCode image inherits its whole toolchain:
# node 24 + npm, gh / glab, jq, yq, tmux, ttyd (plus the patched index page
# with clipboard and touch support at /opt/ttyd/index.html), openssh-client,
# chromium, python3 + venv, rsync, hab, zigporter, the 1Password CLI and the
# opencode runtime itself. This image only adds the workstation packages the
# dotfiles and toolset expect, and swaps the s6 services for a plain terminal.
# ==============================================================================
ARG BASE_IMAGE=flapperdeflipper/addon-ha-opencode:2.8.0
FROM ${BASE_IMAGE}

ARG BUILD_VERSION
ARG BUILD_ARCH

# Package set: the merge of the dotfiles .packages list and the toolset
# config/packages list, so the container matches a normal workstation
# bootstrap (vim, neovim, stow, fzf, bat, shellcheck, the lot). Anything the
# OpenCode base already ships (git, jq, tmux, python3, ...) is listed anyway;
# apt skips what is already installed. Every name verified against trixie.
RUN case "${BUILD_ARCH}" in amd64|aarch64|"") ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        arping \
        autoconf \
        automake \
        awscli \
        bash \
        bash-completion \
        bats \
        bats-assert \
        bats-file \
        bats-support \
        bat \
        bc \
        binutils \
        binwalk \
        bubblewrap \
        ca-certificates \
        cmake \
        colordiff \
        coreutils \
        curl \
        direnv \
        ffmpeg \
        figlet \
        file \
        findutils \
        fzf \
        gawk \
        gcc \
        gettext \
        git \
        gnupg \
        gnupg2 \
        graphviz \
        grep \
        grc \
        highlight \
        htop \
        iftop \
        imagemagick \
        ipcalc \
        irssi \
        jo \
        jq \
        libffi-dev \
        libpcre2-dev \
        libpq-dev \
        libtool \
        libyaml-dev \
        links \
        moreutils \
        mtr \
        ncdu \
        netcat-openbsd \
        ngrep \
        nmap \
        openssh-client \
        openssl \
        p7zip \
        pgbadger \
        pigz \
        pre-commit \
        prettyping \
        procps \
        psutils \
        pwgen \
        python3 \
        python3-venv \
        python3-virtualenv \
        python3-virtualenvwrapper \
        rclone \
        rsync \
        shellcheck \
        sqlite3 \
        stow \
        sudo \
        swaks \
        telnet \
        tmux \
        tofrodos \
        tree \
        unzip \
        vim \
        neovim \
        w3m \
        wget \
        yamllint \
        zoxide \
    && rm -rf /var/lib/apt/lists/*

# Our rootfs: the init and terminal s6 services plus helper scripts
COPY rootfs /

# The base image's s6 user bundle still references every OpenCode service.
# Remove those bundle entries by name so only this add-on's services run; the
# inherited service directories themselves remain but are never started.
RUN rm -f /etc/s6-overlay/s6-rc.d/user/contents.d/ha-opencode \
           /etc/s6-overlay/s6-rc.d/user/contents.d/ha-opencode-server \
           /etc/s6-overlay/s6-rc.d/user/contents.d/ha-opencode-mcp-http \
           /etc/s6-overlay/s6-rc.d/user/contents.d/ha-openchamber \
           /etc/s6-overlay/s6-rc.d/user/contents.d/ha-openchamber-ingress \
           /etc/s6-overlay/s6-rc.d/user/contents.d/ha-openchamber-lan \
           /etc/s6-overlay/s6-rc.d/user/contents.d/init-opencode \
           /etc/s6-overlay/s6-rc.d/user/contents.d/ppq-private-proxy \
    && chmod +x /etc/s6-overlay/s6-rc.d/init-terminal/run \
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

# Labels for Home Assistant (override the OpenCode labels from the base)
LABEL \
    io.hass.name="Terminal" \
    io.hass.description="Personal bash and vim terminal with dotfiles and toolset" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

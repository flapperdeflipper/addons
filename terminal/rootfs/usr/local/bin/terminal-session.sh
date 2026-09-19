#!/usr/bin/env bash
# ==============================================================================
# Terminal Session - wrapper that runs inside ttyd's tmux session
# ==============================================================================

export HOME="/data"
export XDG_DATA_HOME="/data/.local/share"
export XDG_CONFIG_HOME="/data/.config"
export SHELL="/bin/bash"

# Load user-defined environment variables (written by init-terminal)
if [ -f /data/.env_vars ]; then
    source /data/.env_vars
fi

ADDON_VERSION=$(cat /data/.addon_version 2>/dev/null || echo "unknown")

# Sessions start in the Home Assistant configuration directory
cd /homeassistant 2>/dev/null || cd /

# Minimal banner: the dotfiles' own bashrc prints the familiar prompt
printf '\n'
printf 'Terminal add-on v%s - /data is HOME, /homeassistant is the working directory\n' "${ADDON_VERSION}"

if [ ! -d "${HOME}/.dotfiles/.git" ]; then
    printf '\n'
    printf 'Dotfiles are not set up yet. For the private dotfiles repository:\n'
    printf '  1. gh auth login          (interactive, once; stored under %s/.config/gh)\n' "${HOME}"
    printf '  2. dotfiles-sync          (clone, stow, and install dependencies)\n'
    printf 'Or set GH_TOKEN in the add-on env_vars option and restart.\n'
    printf '\n'
fi

exec bash --login

#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e -o pipefail +x

export CONFIG_PATH=/data/options.json

bashio::log.info "Initializing service configuration."

bashio::log.info "Getting firmware directory"
firmware_dir="$( bashio::config firmware_dir )"
firmware_dest="$( bashio::config firmware_dest )"

bashio::log.info "Creating firmware directories if not found"
test -d "${firmware_dir}"  || mkdir -p "${firmware_dir}"
test -d "${firmware_dest}" || mkdir -p "${firmware_dest}"

bashio::log.info "Copying willow firmware from ${firmware_dir} to ${firmware_dest}"
cp -rv "${firmware_dir}"/* "${firmware_dest}"/ || exit 1

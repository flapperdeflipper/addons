#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e -o pipefail +x

ENVFILE=/usr/share/kibana/.env
CONFIG_PATH=/data/options.json

bashio::log.info "Initializing kibana environment."
jq -er '.environment | to_entries | map("\(.key)=\(.value | tostring)") | .[]' < "${CONFIG_PATH}" > "${ENVFILE}"

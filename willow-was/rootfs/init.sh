#!/bin/bash
set -e -o pipefail +x

function log() {
    local severity="${1}"; shift
    local message="${*}"
    echo "$( date ) - ${severity} - ${message}" >&2
}

log INFO "Creating /share/willow/was directories"
mkdir -p /share/willow/was/{storage,firmware} || exit 1

log INFO "Copying files from /app/storage to /share/willow/was/storage"
cp -rv /app/storage/* /share/willow/was/storage/ || exit 1

log INFO "Symlinking /app/storage to /share/willow/was/storage/"
rm -rf /app/storage                     || exit 1
ln -sf /share/willow/was/storage /app/  || exit 1

log INFO "Running /app/entrypoint.sh"
exec /app/entrypoint.sh

#!/bin/bash
set -e -o pipefail +x

echo "--> Creating /share/willow/was directories"
mkdir -p /share/willow/was/{storage,firmware} || exit 1

echo "--> Copying files from /app/storage to /share/willow/was/storage"
cp -rv /app/storage/* /share/willow/was/storage/ || exit 1

echo "--> Symlinking /app/storage to /share/willow/was/storage/"
ln -sf /share/willow/was/storage /app/  || exit 1

echo "--> Running /app/entrypoint.sh"
exec /app/entrypoint.sh

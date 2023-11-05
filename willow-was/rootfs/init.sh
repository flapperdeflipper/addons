#!/bin/bash
set -e -o pipefail +x

mkdir -p /share/willow/was/{storage,firmware} || exit 1

## Create symlink to share storage for storage directory
if [[ ! -L /app/storage ]]
then
    cp -rv /app/storage/* /share/willow/was/storage || exit 1
    ln -sf /share/willow/was/storage /app/storage   || exit 1
fi

exec /app/entrypoint.sh

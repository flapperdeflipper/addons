#!/usr/bin/env bash
# ==============================================================================
# check-base-pins.sh — base-image drift guard (flapperdeflipper/addons)
#
# The Home Assistant builder passes build.yaml's build_from.<arch> as
# --build-arg BUILD_FROM, overriding any default in the Dockerfile. When a
# Dockerfile also carries `ARG BUILD_FROM=<image>` (for plain `docker build`),
# the two drift apart as soon as only one is bumped, and the stale build.yaml
# value is what actually ships.
#
# Fails when a Dockerfile's BUILD_FROM default differs from build.yaml's
# build_from.amd64 (the Dockerfile defaults in this repo are amd64 images).
#
# Usage: scripts/check-base-pins.sh   (from the repo root)
# ==============================================================================
set -euo pipefail

# build_from.<arch> from a build.yaml: the indented "<arch>: <image>" line
# inside the top-level build_from: block. Quotes are optional.
build_from_of() {
    local file="$1" arch="$2"
    awk -v arch="${arch}" '
        /^[^[:space:]#]/ { in_block = ($0 ~ /^build_from:[[:space:]]*$/) ; next }
        in_block && $1 == arch ":" { v = $2; gsub(/"/, "", v); print v; exit }
    ' "${file}"
}

fail=0
checked=0
for dockerfile in */Dockerfile; do
    dir="${dockerfile%/Dockerfile}"
    default="$(sed -n -E 's/^ARG BUILD_FROM=([^[:space:]]+).*$/\1/p' "${dockerfile}" | head -1)"
    [[ -n "${default}" ]] || continue
    if [[ ! -f "${dir}/build.yaml" ]]; then
        continue
    fi
    pinned="$(build_from_of "${dir}/build.yaml" amd64)"
    if [[ -z "${pinned}" ]]; then
        continue
    fi
    checked=$((checked + 1))
    if [[ "${default}" != "${pinned}" ]]; then
        echo "::error file=${dir}/build.yaml::${dir}: build.yaml build_from.amd64 is ${pinned} but the Dockerfile defaults BUILD_FROM to ${default}; the builder ships build.yaml's value, so bump both together"
        fail=1
    else
        echo "${dir}: ${pinned}"
    fi
done

echo "checked ${checked} add-on(s)"
[[ "${fail}" -eq 0 ]] || exit 1

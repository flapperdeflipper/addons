#!/usr/bin/env bash
# ==============================================================================
# check-version-bump.sh — release-convention guard (flapperdeflipper/addons)
#
# Fails when a change set touches an add-on's release-relevant files
# (Dockerfile, build.yaml, requirements, bundled npm under rootfs/) without
# bumping `version:` in that add-on's config.yaml. Merging such a change
# rebuilds and re-pushes an already-released image tag (see mr-workflow guide).
#
# Usage: scripts/check-version-bump.sh <base-ref>   (from the repo root)
# ==============================================================================
set -euo pipefail

BASE_REF="${1:?usage: check-version-bump.sh <base-ref>}"
git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null 2>&1 || {
    echo "check-version-bump: base ref '${BASE_REF}' not found — skipping" >&2
    exit 0
}

version_of() { sed -n -E 's/^version:[[:space:]]*"?([^"#[:space:]]+)"?.*$/\1/p' "${1:-/dev/stdin}" | head -1; }

mapfile -t dirs < <(
    git diff --name-only "${BASE_REF}"...HEAD -- \
        '*/Dockerfile' '*/build.yaml' '*/requirements*.txt' \
        '*/rootfs/**/package.json' '*/rootfs/**/package-lock.json' \
        | cut -d/ -f1 | sort -u
)

fail=0
for dir in "${dirs[@]}"; do
    [ -f "${dir}/config.yaml" ] || continue
    base_version="$(git show "${BASE_REF}:${dir}/config.yaml" 2>/dev/null | version_of)"
    head_version="$(version_of "${dir}/config.yaml")"
    if [ -z "${head_version}" ]; then
        echo "::error file=${dir}/config.yaml::no version found"
        fail=1
        continue
    fi
    if [ "${base_version}" = "${head_version}" ]; then
        echo "::error file=${dir}/config.yaml::${dir}: release files changed but version stayed ${head_version} — bump \`version:\` and add a CHANGELOG entry"
        fail=1
    else
        echo "${dir}: ${base_version:-none} -> ${head_version}"
    fi
done

[ "${fail}" -eq 0 ] || exit 1

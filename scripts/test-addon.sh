#!/usr/bin/env bash
# ==============================================================================
# test-addon.sh — run an add-on's test suites locally, the way CI does
#
# Mirrors the "Run test suites" step of .github/workflows/tests.yml:
#   1. node:test suites in <addon>/test/*.test.js, after `npm ci` of every
#      bundled package under <addon>/rootfs/opt/ (the suites import them)
#   2. bundled packages under rootfs/opt/ that declare an npm test script
#   3. python suites <addon>/test/test_*.py, run through uv with Python 3.15
#      and the packages from <addon>/test/test-requirements.txt (the same
#      file CI installs from)
# With no add-on named, every add-on is tested and scripts/check-base-pins.sh
# runs as well.
#
# Needs node/npm (CI uses Node 26) and uv. uv downloads Python 3.15 on first
# use and caches it; nothing is installed into the repo except node_modules
# (gitignored).
#
# Usage: scripts/test-addon.sh [addon ...]   (from anywhere in the repo)
# ==============================================================================
set -euo pipefail

readonly PYTHON_VERSION="3.15"
readonly NODE_MAJOR="26"

repo_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "${repo_root}"

for tool in node npm uv; do
    command -v "${tool}" >/dev/null 2>&1 || {
        echo "test-addon: ${tool} not found" >&2
        exit 2
    }
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${node_major}" != "${NODE_MAJOR}" ]]; then
    echo "test-addon: warning: Node ${node_major} here, CI runs Node ${NODE_MAJOR}" >&2
fi

if [[ $# -gt 0 ]]; then
    addons=("$@")
else
    addons=()
    for config in */config.yaml; do
        addons+=("${config%/config.yaml}")
    done
fi

run_addon() {
    local addon="$1" suites=0 lock pkg_json pkg_dir py
    local -a uv_args

    if ls "${addon}"/test/*.test.js >/dev/null 2>&1; then
        for lock in "${addon}"/rootfs/opt/*/package-lock.json; do
            [[ -e "${lock}" ]] || continue
            echo "--- ${addon}: npm ci $(dirname "${lock}")"
            (cd "$(dirname "${lock}")" && npm ci --include=dev --no-audit --no-fund --loglevel=error)
        done
        echo "--- ${addon}: node --test"
        (cd "${addon}" && node --test test/*.test.js)
        suites=$((suites + 1))
    fi

    for pkg_json in "${addon}"/rootfs/opt/*/package.json; do
        [[ -e "${pkg_json}" ]] || continue
        pkg_dir="$(dirname "${pkg_json}")"
        if node -e "process.exit(require('./${pkg_json}').scripts?.test ? 0 : 1)"; then
            echo "--- ${addon}: npm test (${pkg_dir})"
            (cd "${pkg_dir}" && npm ci --include=dev --no-audit --no-fund --loglevel=error && npm test)
            suites=$((suites + 1))
        fi
    done

    uv_args=(run --no-project --quiet --python "${PYTHON_VERSION}")
    if [[ -f "${addon}/test/test-requirements.txt" ]]; then
        uv_args+=(--with-requirements "${addon}/test/test-requirements.txt")
    fi
    for py in "${addon}"/test/test_*.py; do
        [[ -e "${py}" ]] || continue
        echo "--- ${addon}: python ${py}"
        uv "${uv_args[@]}" python "${py}"
        suites=$((suites + 1))
    done

    echo "=== ${addon}: ${suites} suite(s) passed"
}

failed=()
for addon in "${addons[@]}"; do
    addon="${addon%/}"
    if [[ ! -f "${addon}/config.yaml" ]]; then
        echo "test-addon: ${addon} is not an add-on directory" >&2
        failed+=("${addon}")
        continue
    fi
    if ! run_addon "${addon}"; then
        failed+=("${addon}")
    fi
done

if [[ $# -eq 0 ]]; then
    echo "--- base image pins"
    scripts/check-base-pins.sh || failed+=("base-pins")
fi

if [[ ${#failed[@]} -gt 0 ]]; then
    echo "FAILED: ${failed[*]}" >&2
    exit 1
fi
echo "all passed"

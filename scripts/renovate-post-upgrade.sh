#!/usr/bin/env bash
# ==============================================================================
# renovate-post-upgrade.sh — Renovate post-upgrade task (flapperdeflipper/addons)
#
# Runs inside the Renovate workspace after dependency files were updated
# (Dockerfile, build.yaml, requirements*.txt). For every add-on whose files
# changed on this branch, applies the repo release convention:
#   * bump `version:` in <addon>/config.yaml — semver patch (X.Y.Z),
#     CalVer YYYY.MM.DD (playwright-browser) or date+counter YYYY.MM.DD.N
#     (mosquitto),
#   * prepend a "## <new version>" section to <addon>/CHANGELOG.md.
#
# Idempotent: an add-on whose config.yaml already differs from the base ref
# is skipped, so repeated branch updates do not double-bump.
# ==============================================================================
set -euo pipefail

BASE_REF="${RENOVATE_BASE_REF:-origin/main}"
if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null 2>&1; then
    echo "post-upgrade: base ref '${BASE_REF}' not found — nothing to do" >&2
    exit 0
fi

# Add-on directories whose release-relevant files changed on this branch:
# committed earlier in the branch's life, or modified in the pending update.
changed_dirs() {
    {
        git diff --name-only "${BASE_REF}" -- '*/Dockerfile' '*/build.yaml' '*/requirements*.txt' 2>/dev/null || true
        git status --porcelain -- '*/Dockerfile' '*/build.yaml' '*/requirements*.txt' \
            | sed -e 's/^...//' -e 's/^"//' -e 's/"$//'
    } | cut -d/ -f1 | sort -u
}

bump_semver() (
    IFS='.' read -r major minor patch <<<"$1"
    echo "${major}.${minor}.$((10#${patch} + 1))"
)

next_calver() { # YYYY.MM.DD — release date; same-day re-release -> next day
    local current="$1" today
    today=$(date -u +%Y.%m.%d)
    if [[ "${current}" < "${today}" ]]; then
        echo "${today}"
    else
        date -u -d "${current} + 1 day" +%Y.%m.%d 2>/dev/null || echo "${today}"
    fi
}

next_date_n() { # YYYY.MM.DD.N — new date resets counter, same date bumps it
    local current="$1" today datepart counter
    today=$(date -u +%Y.%m.%d)
    datepart="${current%.*}"
    counter="${current##*.}"
    if [[ "${datepart}" < "${today}" ]]; then
        echo "${today}.1"
    else
        echo "${datepart}.$((10#${counter} + 1))"
    fi
}

next_version() {
    case "$1" in
        [0-9]*.[0-9]*.[0-9]*.[0-9]*) next_date_n "$1" ;;
        [0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]) next_calver "$1" ;;
        [0-9]*.[0-9]*.[0-9]*) bump_semver "$1" ;;
        *) return 1 ;;
    esac
}

while read -r dir; do
    [ -n "${dir}" ] || continue
    [ -f "${dir}/config.yaml" ] || continue

    # Already bumped on this branch — keep the first bump (idempotency).
    if ! git diff --quiet "${BASE_REF}" -- "${dir}/config.yaml"; then
        echo "post-upgrade: ${dir}: version already bumped on this branch, skipping"
        continue
    fi

    current=$(sed -n -E 's/^version:[[:space:]]*"?([^"#[:space:]]+)"?.*$/\1/p' "${dir}/config.yaml" | head -1)
    if [ -z "${current}" ]; then
        echo "post-upgrade: ${dir}: no top-level version in config.yaml, skipping" >&2
        continue
    fi
    if [ "$(grep -c -E '^version:' "${dir}/config.yaml")" -gt 1 ]; then
        echo "post-upgrade: ${dir}: duplicate top-level version keys in config.yaml — fixing the first, please dedupe" >&2
    fi

    if ! new=$(next_version "${current}"); then
        echo "post-upgrade: ${dir}: unrecognized version scheme '${current}', skipping" >&2
        continue
    fi

    sed -i -E "0,/^version:/s@(^(version:[[:space:]]*)(\"[^\"]*\"|[^[:space:]]+))@\2\"${new}\"@" "${dir}/config.yaml"

    changelog="${dir}/CHANGELOG.md"
    entry="- **Changed** — automated dependency update (Renovate)."
    if [ -f "${changelog}" ]; then
        if ! grep -q "^## ${new}$" "${changelog}"; then
            tmp="$(mktemp)"
            awk -v ver="## ${new}" -v line="${entry}" '
                !done && /^## / { print ver; print ""; print line; print ""; done = 1 }
                { print }
            ' "${changelog}" > "${tmp}"
            # No existing release heading at all — fall back to appending.
            if ! grep -q "^## ${new}$" "${tmp}"; then
                awk -v ver="## ${new}" -v line="${entry}" '
                    { print }
                    END { print ""; print ver; print ""; print line }
                ' "${changelog}" > "${tmp}"
            fi
            mv "${tmp}" "${changelog}"
        fi
    else
        printf '# Changelog\nAll notable changes to this project will be documented in this file.\n\n## %s\n\n%s\n' "${new}" "${entry}" > "${changelog}"
    fi

    echo "post-upgrade: ${dir}: ${current} -> ${new} (+ CHANGELOG entry)"
done < <(changed_dirs)

exit 0

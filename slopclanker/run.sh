#!/usr/bin/env bash
# SlopClanker add-on entrypoint.
#
# Options come from /data/options.json. Secret-valued options hold
# "!secret <name>" strings, which the Supervisor resolves against
# /homeassistant/secrets.yaml before writing the file - values are only
# ever exported as environment variables, never logged.
#
# v1: the shared citizen token is gone. registration_token seeds the
# clanker enrollment pipeline; provider tokens enable read-only MR/PR
# state enrichment (inert when empty). On first start a pre-1.0 database
# at /data/slopclanker.db is renamed to slopclanker-legacy.db and a
# fresh schema-v2 database takes over (handled inside the app).
set -euo pipefail

if [ -f /data/options.json ]; then
    # shellcheck disable=SC1090
    eval "$(python3 - <<'PYEOF'
import json, shlex

opts = json.load(open("/data/options.json"))
ENV_MAP = {
    "registration_token": "SLOPCLANKER_REG_TOKEN",
    "heartbeat_timeout": "SLOPCLANKER_HEARTBEAT_TIMEOUT",
    "trusted_proxy": "SLOPCLANKER_TRUSTED_PROXY",
    "gitea_host": "SLOPCLANKER_GITEA_HOST",
    "github_token": "SLOPCLANKER_GITHUB_TOKEN",
    "gitlab_token": "SLOPCLANKER_GITLAB_TOKEN",
    "gitea_token": "SLOPCLANKER_GITEA_TOKEN",
}
for key, env in ENV_MAP.items():
    value = opts.get(key)
    if value not in (None, ""):
        print(f"export {env}={shlex.quote(str(value))}")
PYEOF
)"
fi

export SLOPCLANKER_HOST=0.0.0.0
export SLOPCLANKER_PORT=8090

echo "[INFO] SlopClanker starting on port ${SLOPCLANKER_PORT} (UI /, API /api, MCP /mcp)"

exec python3 -m app.main

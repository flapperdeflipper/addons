#!/usr/bin/env bash
# SlopClanker add-on entrypoint.
#
# Options come from /data/options.json. The token option holds
# "!secret slopclanker_token", which the Supervisor resolves against
# /homeassistant/secrets.yaml before writing the file - the value is only
# ever exported as SLOPCLANKER_TOKEN, never logged.
set -euo pipefail

if [ -f /data/options.json ]; then
    # shellcheck disable=SC1090
    eval "$(python3 - <<'PYEOF'
import json, shlex

opts = json.load(open("/data/options.json"))
for key in ("token", "heartbeat_timeout"):
    value = opts.get(key)
    if value not in (None, ""):
        print(f"export SLOPCLANKER_{key.upper()}={shlex.quote(str(value))}")
PYEOF
)"
fi

export SLOPCLANKER_HOST=0.0.0.0
export SLOPCLANKER_PORT=8090

echo "[INFO] SlopClanker starting on port ${SLOPCLANKER_PORT} (UI /, API /api, MCP /mcp)"

exec python3 -m app.main

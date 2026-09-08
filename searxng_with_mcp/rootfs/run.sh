#!/bin/sh


python /mcp_server.py --http &

sleep 5
chown searxng:searxng /etc/searxng/ods_config.json

# options.json is single-line JSON: parse it properly (grep/cut is not safe)
set_url=$(python -c "import json;print('true' if (json.load(open('/data/options.json')) or {}).get('set_base_url_for_ingress') else 'false')" 2>/dev/null || echo false)

if [ "$set_url" = "true" ]; then
export SEARXNG_BASE_URL

header="Authorization: Bearer $SUPERVISOR_TOKEN"

SEARXNG_BASE_URL=$(wget -qO- --header="$header" \
    "http://supervisor/addons/self/info" \
    | sed -n 's/.*"ingress_url":"\([^"]*\)".*/\1/p') #sed by ai
fi

# ---------------------------------------------- managed search engines ------
# The Supervisor natively resolves '!secret <key>' option values against
# /homeassistant/secrets.yaml before writing /data/options.json, so the token
# arrives already resolved. Guard: if it ever shows up unresolved, disable
# the engine rather than write the marker into settings.yml.
GHC_TOKEN=$(python -c "import json;print(str((json.load(open('/data/options.json')) or {}).get('github_token') or '').strip())" 2>/dev/null || echo "")
case "${GHC_TOKEN}" in
    "!secret"*)
        echo "[WARN] github_token arrived unresolved - github code engine disabled"
        GHC_TOKEN=""
        ;;
esac
GITLAB_ENGINE=$(python -c "import json;print('true' if (json.load(open('/data/options.json')) or {}).get('gitlab_engine', True) else 'false')" 2>/dev/null || echo true)
export GHC_TOKEN GITLAB_ENGINE

# Inject/update the managed engines block (github code + gitlab) in
# settings.yml. Optional functionality - never blocks the add-on.
python /secrets_engines.py || echo "[WARN] managed engines patch failed - searxng continues"

# SearXNG allows only the html output format by default; the MCP endpoint
# queries with format=json, which 403s until json is listed in
# search.formats. Idempotent; never blocks the add-on.
python /search_formats.py || echo "[WARN] search formats patch failed - searxng continues"
unset GHC_TOKEN GITLAB_ENGINE

if [ ! -f /etc/searxng/custom.sh ]; then
    cp /custom.sh /etc/searxng/custom.sh
fi

chmod +x /etc/searxng/custom.sh

exec /etc/searxng/custom.sh

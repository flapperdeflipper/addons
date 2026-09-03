#!/bin/bash
# LiteLLM proxy add-on entrypoint.
#
# Persistent state (all under /data, survives restarts and rebuilds):
#   /data/litellm/config.yaml  LiteLLM proxy config. Generated from a starter
#                              template on first boot ONLY - never overwritten,
#                              so hand edits survive restarts. Enable the
#                              "reset_config" option to regenerate it (the old
#                              file is kept next to it as a .bak copy).
#   /data/litellm/master_key   Auto-generated LiteLLM master key, used when the
#                              "master_key" option is left empty. Mode 600.
#
# Provider API keys are NOT stored in the config file: add them as name/value
# pairs in the "env_vars" add-on option and reference them from the config as
# os.environ/<NAME>. The values live in Home Assistant's add-on options store
# and are injected as environment variables on every start.
set -e

DATA_DIR=/data/litellm
CONFIG_FILE=${DATA_DIR}/config.yaml
KEY_FILE=${DATA_DIR}/master_key
PORT=4000

echo "========================================"
echo "  LiteLLM Proxy add-on starting"
echo "========================================"

mkdir -p "${DATA_DIR}"

## ---------------------------------------------------------------- options ----

# Parse /data/options.json with python3 (always present in the image; no jq).
# Emits shell assignments that are eval'd below. Environment variable names
# are re-validated against [A-Z_][A-Z0-9_]* before being exported.
eval "$(python3 - <<'PYEOF'
import json, re, shlex

try:
    with open('/data/options.json') as f:
        opts = json.load(f)
except (OSError, ValueError):
    opts = {}

def q(value):
    return shlex.quote(str(value))

master_key = opts.get('master_key') or ''
print('MASTER_KEY_OPT=' + q(master_key))
print('RESET_CONFIG=' + q('true' if opts.get('reset_config') else 'false'))

exported = []
for item in opts.get('env_vars') or []:
    if not isinstance(item, dict):
        continue
    name, value = item.get('name'), item.get('value')
    if name and value is not None and re.fullmatch(r'[A-Z_][A-Z0-9_]*', name):
        print('export ' + name + '=' + q(value))
        exported.append(name)

# Log names only - values are secrets.
print('EXPORTED_KEYS=' + q(' '.join(exported)))
PYEOF
)"

if [ -n "${EXPORTED_KEYS}" ]; then
    echo "[INFO] Injected environment variables: ${EXPORTED_KEYS}"
fi

## ------------------------------------------------------------- master key ----

if [ -n "${MASTER_KEY_OPT}" ]; then
    LITELLM_MASTER_KEY="${MASTER_KEY_OPT}"
    echo "[INFO] Using master key from add-on options"
elif [ -f "${KEY_FILE}" ]; then
    LITELLM_MASTER_KEY="$(cat "${KEY_FILE}")"
    echo "[INFO] Using persisted master key (${KEY_FILE})"
else
    LITELLM_MASTER_KEY="sk-$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
    printf '%s' "${LITELLM_MASTER_KEY}" > "${KEY_FILE}"
    chmod 600 "${KEY_FILE}"
    echo "[INFO] Generated new master key and stored it at ${KEY_FILE}"
fi
export LITELLM_MASTER_KEY

## ------------------------------------------------------------ config file ----

if [ "${RESET_CONFIG}" = "true" ] && [ -f "${CONFIG_FILE}" ]; then
    BACKUP="${CONFIG_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    echo "[INFO] reset_config enabled: backing up ${CONFIG_FILE} to ${BACKUP}"
    mv "${CONFIG_FILE}" "${BACKUP}"
fi

if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[INFO] No config found - writing starter config to ${CONFIG_FILE}"
    cat > "${CONFIG_FILE}" <<'EOF'
# LiteLLM proxy configuration.
#
# This file is YOURS. It was generated once on first boot and is never
# overwritten by the add-on, so any edit you make survives restarts and
# rebuilds. To start fresh, enable the "reset_config" add-on option and
# restart - the old file is kept as config.yaml.bak.<timestamp>.
#
# API keys are read from environment variables configured in the add-on
# options (env_vars) and referenced here as os.environ/<NAME>.
#
# Full reference: https://docs.litellm.ai/docs/proxy/configs

model_list:
  # DeepSeek - set DEEPSEEK_API_KEY in the add-on env_vars options
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY

  - model_name: deepseek-reasoner
    litellm_params:
      model: deepseek/deepseek-reasoner
      api_key: os.environ/DEEPSEEK_API_KEY

  # Z.ai (Zhipu GLM) - set ZAI_API_KEY in the add-on env_vars options
  - model_name: glm-4.7
    litellm_params:
      model: zai/glm-4.7
      api_key: os.environ/ZAI_API_KEY

  # More providers - uncomment and adjust as needed:
  # - model_name: gpt-4o-mini
  #   litellm_params:
  #     model: openai/gpt-4o-mini
  #     api_key: os.environ/OPENAI_API_KEY
  # - model_name: claude-sonnet-4-5
  #   litellm_params:
  #     model: anthropic/claude-sonnet-4-5
  #     api_key: os.environ/ANTHROPIC_API_KEY
  # - model_name: llama3
  #   litellm_params:
  #     model: ollama/llama3
  #     api_base: http://ollama:11434

litellm_settings:
  # Ignore unsupported parameters instead of erroring (e.g. when clients
  # send OpenAI-specific options to non-OpenAI providers)
  drop_params: true

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY

  # The litellm-database image can serve the admin UI, virtual keys and
  # spend tracking when connected to PostgreSQL. Point DATABASE_URL (via
  # the add-on env_vars options) at a Postgres server and uncomment:
  # database_url: os.environ/DATABASE_URL
EOF
else
    echo "[INFO] Using existing config at ${CONFIG_FILE} (left untouched)"
fi

## ------------------------------------------------------------------ start ----

echo "[INFO] Starting LiteLLM proxy on port ${PORT}"
echo "[INFO] OpenAI-compatible endpoint: http://litellm:${PORT}/v1"

# Chain through the upstream entrypoint (handles e.g. USE_DDTRACE=true).
exec /app/docker/prod_entrypoint.sh --config "${CONFIG_FILE}" --port "${PORT}"

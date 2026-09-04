#!/bin/bash
# LiteLLM proxy add-on entrypoint.
#
# Secrets policy: this add-on stores NO secret values. Its options hold only
# KEY NAMES referencing /homeassistant/secrets.yaml (HA config is mapped
# read-only), e.g.:
#   master_key: litellm_master_key
#   env_vars:
#     - { name: DATABASE_URL, secret: litellm_database_dsn }
# Values are resolved from secrets.yaml at every start and injected as
# environment variables. (Add-on options DO support HA-style '!secret <key>'
# values - the Supervisor resolves them against secrets.yaml before writing
# /data/options.json. This add-on keeps its key-name scheme anyway, because
# the env_vars list maps many NAME->secret pairs from a single option and
# master_key stays a bare key name. Literal { name: ..., value: password }
# entries still work too.)
#
# Persistent state (all under /data, survives restarts and rebuilds):
#   /data/litellm/config.yaml  LiteLLM proxy config. Generated from a starter
#                              template on first boot ONLY - never overwritten,
#                              so hand edits survive restarts. Enable the
#                              "reset_config" option to regenerate it (the old
#                              file is kept next to it as a .bak copy).
#   /data/litellm/master_key   Fallback master key, auto-generated ONLY when
#                              the master_key option is empty/unresolvable.
set -e

DATA_DIR=/data/litellm
# Primary config location: /homeassistant/litellm/config.yaml (HA config dir,
# mapped read-only). It is edited from OUTSIDE the add-on (opencode, SSH,
# file editor); the add-on only reads it. Fallback: /data/litellm/config.yaml.
CONFIG_DIR=/homeassistant/litellm
CONFIG_FILE=${CONFIG_DIR}/config.yaml
FALLBACK_CONFIG=${DATA_DIR}/config.yaml
KEY_FILE=${DATA_DIR}/master_key
SECRETS_FILE=/homeassistant/secrets.yaml
PORT=4000

# Prefer the venv python from the LiteLLM image (has PyYAML guaranteed).
PY=/app/.venv/bin/python3
command -v "${PY}" >/dev/null 2>&1 || PY=python3

echo "========================================"
echo "  LiteLLM Proxy add-on starting"
echo "========================================"

mkdir -p "${DATA_DIR}"

## ------------------------------------------------- options + secrets ------

# Resolve options against secrets.yaml in one python pass. Emits shell
# assignments (eval'd below). Only names are ever logged - never values.
eval "$("${PY}" - "${SECRETS_FILE}" <<'PYEOF'
import json, re, shlex, sys, os

secrets_path = sys.argv[1]

try:
    with open('/data/options.json') as f:
        opts = json.load(f)
except (OSError, ValueError):
    opts = {}

secrets = {}
if os.path.isfile(secrets_path):
    try:
        import yaml
        loaded = yaml.safe_load(open(secrets_path))
        if isinstance(loaded, dict):
            secrets = loaded
    except Exception as err:
        print('SECRETS_ERROR=' + shlex.quote(str(err)))
else:
    print('SECRETS_ERROR=missing ' + secrets_path)

def q(value):
    return shlex.quote(str(value))

def resolve(key_name):
    """Look a key up in secrets.yaml. Returns (value, ok)."""
    if key_name and key_name in secrets and secrets[key_name] not in (None, ''):
        return str(secrets[key_name]), True
    return '', False

print('RESET_CONFIG=' + q('true' if opts.get('reset_config') else 'false'))

# Master key: option value is a secrets.yaml KEY NAME.
mk_name = opts.get('master_key') or ''
mk_value, mk_ok = resolve(mk_name) if mk_name else ('', False)
print('MASTER_KEY_OPT=' + q(mk_value))
print('MASTER_KEY_OK=' + q('true' if mk_ok else 'false'))
if mk_name and not mk_ok:
    sys.stderr.write('[WARN] master_key option "%s" not found/empty in secrets.yaml\n' % mk_name)

exported, warned = [], []
for item in opts.get('env_vars') or []:
    if not isinstance(item, dict):
        continue
    name = item.get('name')
    if not name or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', name):
        continue
    if item.get('secret'):
        value, ok = resolve(item['secret'])
        if not ok:
            warned.append('%s (secret "%s" not found)' % (name, item['secret']))
            continue
        src = 'secret:' + item['secret']
    elif item.get('value') is not None:
        value, src = str(item['value']), 'literal'
    else:
        continue
    print('export ' + name + '=' + q(value))
    exported.append('%s<-%s' % (name, src))

print('EXPORTED_KEYS=' + q(', '.join(exported)))
print('UNRESOLVED=' + q('; '.join(warned)))
PYEOF
)"

if [ -n "${SECRETS_ERROR:-}" ]; then
    echo "[WARN] Could not read ${SECRETS_FILE}: ${SECRETS_ERROR}"
fi
if [ -n "${EXPORTED_KEYS}" ]; then
    echo "[INFO] Injected environment variables: ${EXPORTED_KEYS}"
fi
if [ -n "${UNRESOLVED}" ]; then
    echo "[WARN] Skipped (check secrets.yaml keys): ${UNRESOLVED}"
fi

## ------------------------------------------------------------- master key ----

if [ "${MASTER_KEY_OK}" = "true" ]; then
    echo "[INFO] Using master key resolved from secrets.yaml"
elif [ -f "${KEY_FILE}" ]; then
    LITELLM_MASTER_KEY="$(cat "${KEY_FILE}")"
    echo "[INFO] Using persisted fallback master key (${KEY_FILE})"
else
    LITELLM_MASTER_KEY="sk-$("${PY}" -c 'import secrets; print(secrets.token_hex(24))')"
    printf '%s' "${LITELLM_MASTER_KEY}" > "${KEY_FILE}"
    chmod 600 "${KEY_FILE}"
    echo "[INFO] Generated fallback master key at ${KEY_FILE} (set the master_key option to a secrets.yaml key to control it)"
fi
if [ "${MASTER_KEY_OK}" = "true" ]; then
    LITELLM_MASTER_KEY="${MASTER_KEY_OPT}"
fi
export LITELLM_MASTER_KEY

## ------------------------------------------------------------ config file ----

# Prefer the externally-managed config in the HA config dir
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[WARN] ${CONFIG_FILE} not found - falling back to ${FALLBACK_CONFIG}"
    CONFIG_FILE="${FALLBACK_CONFIG}"
fi

if [ "${RESET_CONFIG}" = "true" ] && [ -f "${CONFIG_FILE}" ] && [ "${CONFIG_FILE}" = "${FALLBACK_CONFIG}" ]; then
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
# It intentionally contains NO secrets: provider keys are resolved from
# Home Assistant's secrets.yaml at startup (env_vars add-on option) and
# referenced here as os.environ/<NAME>.
#
# Full reference: https://docs.litellm.ai/docs/proxy/configs

model_list:
  # DeepSeek - env_vars: { name: DEEPSEEK_API_KEY, secret: deepseek_api_token }
  - model_name: deepseek-v4-flash
    litellm_params:
      model: deepseek/deepseek-v4-flash
      api_key: os.environ/DEEPSEEK_API_KEY

  - model_name: deepseek-v4-pro
    litellm_params:
      model: deepseek/deepseek-v4-pro
      api_key: os.environ/DEEPSEEK_API_KEY

  # Z.ai (Zhipu GLM) coding plan - endpoint differs from the standard API!
  # env_vars: { name: ZAI_API_KEY, secret: z_ai_api_token }
  - model_name: glm-5.2
    litellm_params:
      model: zai/glm-5.2
      api_base: https://api.z.ai/api/coding/paas/v4
      api_key: os.environ/ZAI_API_KEY

  - model_name: glm-5.3
    litellm_params:
      model: zai/glm-5.3
      api_base: https://api.z.ai/api/coding/paas/v4
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

  # PostgreSQL is enabled purely by setting the DATABASE_URL env var
  # (env_vars: { name: DATABASE_URL, secret: <your dsn key> }). No line needs
  # to be uncommented - LiteLLM reads the environment variable directly.
  # database_url: os.environ/DATABASE_URL
EOF
else
    echo "[INFO] Using existing config at ${CONFIG_FILE} (left untouched)"
fi

## --------------------------------------------------------------- mcp server ------

## ------------------------------------------------------------------ start ----

echo "[INFO] Starting LiteLLM proxy on port ${PORT}"
echo "[INFO] OpenAI-compatible endpoint: http://litellm:${PORT}/v1"

# Chain through the upstream entrypoint (handles e.g. USE_DDTRACE=true).
exec /app/docker/prod_entrypoint.sh --config "${CONFIG_FILE}" --port "${PORT}"

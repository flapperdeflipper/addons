#!/bin/bash
# Mealie add-on entrypoint.
#
# Runs as root: reads /data/options.json, exports Mealie's environment, puts
# the OIDC client secret in a file only the Mealie user can read (Mealie's
# own *_FILE secret pattern), then hands over to the upstream entrypoint
# /app/run.sh. That script drops to PUID/PGID (911) via gosu, loads the
# secret file into the mealie process environment and execs mealie. The
# value stays out of this wrapper's environment, the log and docker inspect.
set -euo pipefail

MEALIE_UID=911
MEALIE_GID=911
DATA_DIR=/data/mealie
SECRETS_DIR=/run/mealie-secrets

echo "[mealie] add-on starting"

# One python pass over the options. Emits shell assignments; values are
# shlex-quoted and never logged. The OIDC secret is written to its file here
# so it never passes through the shell. Captured first: a failure inside
# eval "$(...)" would otherwise be swallowed.
SETTINGS=$(
    python3 - "${SECRETS_DIR}" <<'PYEOF'
import json, os, shlex, sys

secrets_dir = sys.argv[1]
with open('/data/options.json', encoding='utf-8') as fh:
    opts = json.load(fh)
oidc = opts.get('oidc') or {}

def emit(name, value):
    print('%s=%s' % (name, shlex.quote(str(value))))

def fail(msg):
    emit('CONFIG_ERROR', msg)
    sys.exit(0)

def text(value):
    return '' if value is None else str(value).strip()

def flag(value):
    return 'true' if value else 'false'

def unresolved(value):
    return text(value).startswith('!secret ')

base_url = text(opts.get('base_url'))
trusted = text(opts.get('trusted_proxies'))
if trusted == '*':
    fail("trusted_proxies '*' trusts forwarded headers from every source; list the proxy addresses instead")

env = {
    'ALLOW_SIGNUP': 'false',
    'ALLOW_PASSWORD_LOGIN': flag(opts.get('allow_password_login', True)),
    'TOKEN_TIME': opts.get('token_time_hours', 48),
    'MAX_UPLOAD_SIZE_MB': opts.get('max_upload_size_mb', 1024),
    # Empty string = trust no forwarding proxy (upstream default is '*').
    'HOST_IP': trusted,
    'HTTP_ALLOW_LIST': text(opts.get('http_allow_list')),
    'LOG_LEVEL': text(opts.get('log_level')) or 'info',
    'OIDC_AUTH_ENABLED': flag(oidc.get('enabled')),
}
if base_url:
    env['BASE_URL'] = base_url.rstrip('/')

if oidc.get('enabled'):
    for key in ('configuration_url', 'client_id', 'client_secret'):
        if not text(oidc.get(key)):
            fail('oidc.enabled is true but oidc.%s is empty' % key)
        if unresolved(oidc.get(key)):
            fail('oidc.%s is an unresolved !secret reference (key missing in secrets.yaml)' % key)
    if not base_url:
        fail('oidc.enabled needs base_url: it is the base of the OIDC callback URL')
    env.update({
        'OIDC_CONFIGURATION_URL': text(oidc['configuration_url']),
        'OIDC_CLIENT_ID': text(oidc['client_id']),
        'OIDC_PROVIDER_NAME': text(oidc.get('provider_name')) or 'OAuth',
        'OIDC_SIGNUP_ENABLED': flag(oidc.get('signup_enabled', True)),
        'OIDC_AUTO_REDIRECT': flag(oidc.get('auto_redirect')),
        'OIDC_REMEMBER_ME': flag(oidc.get('remember_me')),
    })
    for key, name in (('user_group', 'OIDC_USER_GROUP'), ('admin_group', 'OIDC_ADMIN_GROUP')):
        if text(oidc.get(key)):
            env[name] = text(oidc[key])
    os.makedirs(secrets_dir, mode=0o700, exist_ok=True)
    path = os.path.join(secrets_dir, 'oidc_client_secret')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        fh.write(text(oidc['client_secret']))
    env['OIDC_CLIENT_SECRET_FILE'] = path
elif not opts.get('allow_password_login', True):
    fail('allow_password_login is false and OIDC is disabled: nobody could log in')

for name, value in env.items():
    emit('export ' + name, value)
PYEOF
)
eval "${SETTINGS}"

if [[ -n "${CONFIG_ERROR:-}" ]]; then
    echo "[mealie] configuration error: ${CONFIG_ERROR}" >&2
    echo "[mealie] fix the add-on Configuration tab, then restart" >&2
    exit 1
fi

if [[ -d "${SECRETS_DIR}" ]]; then
    chown -R "${MEALIE_UID}:${MEALIE_GID}" "${SECRETS_DIR}"
fi

mkdir -p "${DATA_DIR}"
chown -R "${MEALIE_UID}:${MEALIE_GID}" "${DATA_DIR}"
export DATA_DIR

# shellcheck disable=SC2154 # both are exported by the eval above
echo "[mealie] data dir ${DATA_DIR}, OIDC ${OIDC_AUTH_ENABLED}, password login ${ALLOW_PASSWORD_LOGIN}, trusted proxies '${HOST_IP:-none}'"

exec /app/run.sh "$@"

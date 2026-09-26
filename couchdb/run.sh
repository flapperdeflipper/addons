#!/usr/bin/env bash
# shellcheck shell=bash
set -Eeuo pipefail

# Generic CouchDB add-on with MariaDB-style declarative management:
# databases, logins (server admins + regular users) and per-database rights,
# plus an optional agent docstore MCP endpoint (docstore/).
#
# History: fork of alexbelgium/hassio-addons obsidian_syncserver_solo (MIT),
# published here as obsidian-sync, then generalized into this add-on in
# 3.6.0. The Obsidian LiveSync provisioning lives on as the default CORS
# origins.

OPTIONS_JSON="/data/options.json"
ADDON_DIR="/config/couchdb"
USERS_DIR="${ADDON_DIR}/users"
DATA_DIR="${ADDON_DIR}/data"
DOCSTORE_DIR="${ADDON_DIR}/docstore"
LOCAL_D="/opt/couchdb/etc/local.d"
COUCH_URL="http://127.0.0.1:5984"
DOCSTORE_PORT=5985

# Retry budget matches upstream's provision tool: CouchDB can take a while to
# open its listener on first boot.
READY_RETRIES=12
READY_DELAY=5

DB_NAME_RE='^[a-z][a-z0-9_$()+/-]*$'

log() { echo "[couchdb] $*"; }
warn() { echo "[couchdb] WARN: $*" >&2; }
die() { echo "[couchdb] ERROR: $*" >&2; exit 1; }

read_opt() {
    jq -er --arg k "$1" '.[$k]' "$OPTIONS_JSON" 2> /dev/null || true
}

# ---------------------------------------------------------------------------
# Step 1: Read and validate add-on options
# ---------------------------------------------------------------------------
[[ -f "$OPTIONS_JSON" ]] || die "Missing options file at ${OPTIONS_JSON}"

LOG_LEVEL="$(read_opt log_level)"
LOG_LEVEL="${LOG_LEVEL:-info}"

mapfile -t DATABASES < <(jq -r '.databases // [] | .[]' "$OPTIONS_JSON")
[[ ${#DATABASES[@]} -gt 0 ]] || die "databases must list at least one database"
for db in "${DATABASES[@]}"; do
    [[ "$db" =~ $DB_NAME_RE ]] \
        || die "database '${db}' is invalid. Must start with a lowercase letter, a-z 0-9 _ \$ ( ) + / -"
done
declare -A DB_SET=()
for db in "${DATABASES[@]}"; do DB_SET["$db"]=1; done

# Supervisor expands '!secret <key>' references when it writes this file at
# container start. A value that is STILL a '!secret …' string here means the
# key was missing from secrets.yaml — running on would provision garbage.
if grep -q '"!secret ' "$OPTIONS_JSON"; then
    die "unresolved !secret reference in options: $(grep -o '"!secret [^"]*"' "$OPTIONS_JSON" | sort -u | tr '
' ' ')"
fi

LOGINS_COUNT="$(jq '.logins // [] | length' "$OPTIONS_JSON")"
RIGHTS_COUNT="$(jq '.rights // [] | length' "$OPTIONS_JSON")"
CORS_ORIGINS="$(jq -r '.cors.origins // [] | join(",")' "$OPTIONS_JSON")"
DOCSTORE_ENABLED="$(jq -r '.docstore.enabled // false' "$OPTIONS_JSON")"
DOCSTORE_USERNAME="$(jq -r '.docstore.username // "agent"' "$OPTIONS_JSON")"

mkdir -p "$ADDON_DIR" "$USERS_DIR"

# ---------------------------------------------------------------------------
# Step 2: Resolve credentials
#
# Logins with server_admin:true are CouchDB server administrators; at least
# one is required and more are allowed. The first is the bootstrap admin
# (passed to the image entrypoint); every start converges ALL of them (see
# Step 6) so password or username changes in the options apply on restart. Any login with a blank password gets a strong generated one
# persisted under /config — never printed to the log, since Supervisor logs
# end up in diagnostics and support bundles.
# ---------------------------------------------------------------------------
login_field() {
    # $1 = index, $2 = field (username|password|admin — literal keys only)
    jq -r --argjson i "$1" ".logins // [] | .[\$i].$2 // empty" "$OPTIONS_JSON"
}

resolve_password() {
    # $1 = username, $2 = stored password from options (may be empty)
    local username="$1" stored="$2" file="${USERS_DIR}/${1}.password"
    if [[ -n "$stored" ]]; then printf '%s' "$stored"; return; fi
    if [[ -f "$file" ]]; then cat "$file"; return; fi
    local generated
    generated="$(openssl rand -base64 24)"
    (
        umask 077
        printf '%s' "$generated" > "$file"
    )
    warn "Generated password for '${username}', saved to ${file}"
    printf '%s' "$generated"
}

ADMIN_USERNAME="$(jq -r 'first((.logins // [])[] | select(.server_admin == true) | .username) // empty' "$OPTIONS_JSON")"
[[ -n "$ADMIN_USERNAME" ]] || die "no login has server_admin: true — exactly one is required"

# Migration from obsidian-sync: adopt the previously generated admin password
# so migrated vaults keep their credentials (and LiveSync clients keep working).
# Must run before resolve_password() gets a chance to generate a fresh one.
if [[ ! -f "${USERS_DIR}/${ADMIN_USERNAME}.password" && -f "${ADDON_DIR}/admin_password" ]]; then
    mv "${ADDON_DIR}/admin_password" "${USERS_DIR}/${ADMIN_USERNAME}.password"
    log "Adopted obsidian-sync admin password for '${ADMIN_USERNAME}'"
fi

ADMIN_PASSWORD=""
for i in $(seq 0 $((LOGINS_COUNT - 1))); do
    username="$(login_field "$i" username)"
    password="$(login_field "$i" password)"
    is_admin="$(login_field "$i" server_admin)"
    [[ -n "$username" ]] || die "logins[$i] is missing a username"
    if [[ "$is_admin" == "true" ]] && [[ "$username" == "$ADMIN_USERNAME" ]]; then
        ADMIN_PASSWORD="$(resolve_password "$username" "$password")"
    fi
done
[[ -n "$ADMIN_PASSWORD" ]] || die "internal: admin password unresolved"
export COUCHDB_USER="$ADMIN_USERNAME"
export COUCHDB_PASSWORD="$ADMIN_PASSWORD"

# ---------------------------------------------------------------------------
# Step 3: Point CouchDB at persistent storage
#
# /data is wiped on reinstall and is not included in Home Assistant backups
# the way the add-on config directory is. Databases are the whole point of
# this add-on, so they live under /config instead.
# ---------------------------------------------------------------------------
mkdir -p "$DATA_DIR" "$DATA_DIR/.delayed" "$LOCAL_D"

COUCH_UID="$(id -u couchdb 2> /dev/null || echo 5984)"
COUCH_GID="$(id -g couchdb 2> /dev/null || echo 5984)"
chown -R "${COUCH_UID}:${COUCH_GID}" "$ADDON_DIR" 2> /dev/null \
    || warn "Could not chown ${ADDON_DIR}; CouchDB may fail to write to it"

cat > "${LOCAL_D}/10-addon-storage.ini" << EOF
; Managed by the Home Assistant add-on. Edits are overwritten on restart.
[couchdb]
database_dir = ${DATA_DIR}
view_index_dir = ${DATA_DIR}

[chttpd]
bind_address = 0.0.0.0
port = 5984

[log]
level = ${LOG_LEVEL}
EOF

# ---------------------------------------------------------------------------
# Step 4: Start CouchDB in the background
# ---------------------------------------------------------------------------
log "Starting CouchDB (databases: ${DATABASES[*]}, log_level=${LOG_LEVEL})"
/docker-entrypoint.sh /opt/couchdb/bin/couchdb &
COUCH_PID=$!

# Without this, a CouchDB that dies during provisioning leaves the script
# retrying against a socket that will never come up.
DOCSTORE_PID=""
cleanup() {
    { [[ -n "$DOCSTORE_PID" ]] && kill -TERM "$DOCSTORE_PID" 2> /dev/null; } || true
    kill -TERM "$COUCH_PID" 2> /dev/null || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Step 5: Wait for CouchDB to accept requests
# ---------------------------------------------------------------------------
ready=false
for i in $(seq 1 "$READY_RETRIES"); do
    if curl -fsS -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" "${COUCH_URL}/_up" > /dev/null 2>&1; then
        ready=true
        break
    fi
    kill -0 "$COUCH_PID" 2> /dev/null || die "CouchDB exited during startup. See the log above."
    log "Waiting for CouchDB to come up (${i}/${READY_RETRIES})"
    sleep "$READY_DELAY"
done
[[ "$ready" == "true" ]] || die "CouchDB did not become ready after $((READY_RETRIES * READY_DELAY))s"

log "CouchDB is up, applying configuration"

# ---------------------------------------------------------------------------
# Step 6: Provision — every call below is idempotent, so this runs safely on
# each start and repairs configuration changed by hand in Fauxton.
#
# NON-DESTRUCTIVE BY DESIGN: provisioning only ever CREATES or ADDS.
# Removing a database, login or right from the options never deletes or
# revokes the corresponding object inside CouchDB — clean-up is a manual,
# deliberate act (Fauxton or curl). The only automated deleter in this
# add-on is the docstore sweeper, and it removes solely expired documents
# in registry databases. Nothing ever drops indexes, design documents,
# databases or users.
# ---------------------------------------------------------------------------

# Promotes the single node out of the uninitialised state. A node that is
# already set up answers 400/409 with "already"/"finished": success here.
cluster_body="$(jq -nc \
    --arg u "$ADMIN_USERNAME" --arg p "$ADMIN_PASSWORD" \
    '{action:"enable_single_node",username:$u,password:$p,bind_address:"0.0.0.0",port:5984,singlenode:true}')"

cluster_response="$(curl -sS -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" \
    -X POST "${COUCH_URL}/_cluster_setup" \
    -H "Content-Type: application/json" \
    -d "$cluster_body" \
    -w '\n%{http_code}' 2>&1 || true)"
cluster_code="$(printf '%s' "$cluster_response" | tail -n1)"
cluster_text="$(printf '%s' "$cluster_response" | sed '$d')"

case "$cluster_code" in
    2*) log "Single-node cluster initialised" ;;
    400 | 409)
        if printf '%s' "$cluster_text" | grep -qi 'already\|finished'; then
            log "Single-node cluster already initialised"
        else
            die "Cluster setup failed (HTTP ${cluster_code}): ${cluster_text}"
        fi
        ;;
    *) die "Cluster setup failed (HTTP ${cluster_code}): ${cluster_text}" ;;
esac

set_config() {
    local label="$1" key="$2" value="$3" code
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" \
        -X PUT "${COUCH_URL}/_node/_local/_config/${key}" \
        -H "Content-Type: application/json" \
        -d "$value" 2>&1 || true)"
    case "$code" in
        2*) log "  set ${label}" ;;
        *) die "Failed to ${label} (HTTP ${code}) at ${key}" ;;
    esac
}

# Converge server administrators: every login with server_admin:true is
# (re)asserted in the [admins] config on every start, so password or username
# changes in the options apply on restart. Removing a login from the options
# does NOT revoke an existing administrator (non-destructive contract) -
# revocation is a manual, deliberate act.
for i in $(seq 0 $((LOGINS_COUNT - 1))); do
    [[ "$(login_field "$i" server_admin)" == "true" ]] || continue
    username="$(login_field "$i" username)"
    password="$(resolve_password "$username" "$(login_field "$i" password)")"
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" \
        -X PUT "${COUCH_URL}/_node/_local/_config/admins/$(printf '%s' "$username" | jq -sRr @uri)" \
        -H "Content-Type: application/json" \
        -d "$(printf '%s' "$password" | jq -Rs .)" 2>&1 || true)"
    case "$code" in
        2*) log "  server admin '${username}' asserted" ;;
        *) die "Failed to assert server admin '${username}' (HTTP ${code})" ;;
    esac
done

set_config "require authenticated HTTP users" "chttpd/require_valid_user" '"true"'
set_config "require authenticated HTTP users for authentication" "chttpd_auth/require_valid_user" '"true"'
set_config "the HTTP authentication challenge" "httpd/WWW-Authenticate" '"Basic realm=\"couchdb\""'
set_config "the maximum HTTP request size" "chttpd/max_http_request_size" '"4294967296"'
set_config "the maximum document size" "couchdb/max_document_size" '"50000000"'

# CORS lets browser-like clients (the Obsidian desktop and mobile apps) talk
# to CouchDB at all. Configured from cors.origins; an empty list disables it.
if [[ -n "$CORS_ORIGINS" ]]; then
    set_config "enable HTTP CORS" "httpd/enable_cors" '"true"'
    set_config "enable clustered HTTP CORS" "chttpd/enable_cors" '"true"'
    set_config "enable CORS credentials" "cors/credentials" '"true"'
    set_config "allowed CORS origins" "cors/origins" "$(jq -Rn --arg v "$CORS_ORIGINS" '$v')"
else
    set_config "disable HTTP CORS" "httpd/enable_cors" '"false"'
    set_config "disable clustered HTTP CORS" "chttpd/enable_cors" '"false"'
fi

# 412 means the database is already there — the normal case after first start.
create_db() {
    local db="$1" code
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" \
        -X PUT "${COUCH_URL}/$(printf '%s' "$db" | jq -sRr @uri)" 2>&1 || true)"
    case "$code" in
        2*) log "  created database '${db}'" ;;
        412) log "  database '${db}' already exists" ;;
        *) die "Failed to create database '${db}' (HTTP ${code})" ;;
    esac
}

for db in "${DATABASES[@]}"; do
    create_db "$db"
done

# Regular (non-admin) users live in the _users database. The password field
# is re-written on every start: CouchDB hashes it server-side, which keeps
# this idempotent and lets password changes take effect on restart.
ensure_user() {
    local username="$1" password="$2" url code rev body
    url="${COUCH_URL}/_users/org.couchdb.user:$(printf '%s' "$username" | jq -sRr @uri)"
    rev=""
    code="$(curl -sS -o /tmp/userdoc.json -w '%{http_code}' \
        -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" "${url}" 2>&1 || true)"
    case "$code" in
        200) rev="$(jq -r '._rev // empty' /tmp/userdoc.json 2> /dev/null || true)" ;;
        404) : ;;
        *) die "Failed to look up user '${username}' (HTTP ${code})" ;;
    esac
    if [[ -n "$rev" ]]; then
        body="$(jq -nc --arg u "$username" --arg p "$password" --arg r "$rev" \
            '{_id:("org.couchdb.user:"+$u),name:$u,type:"user",roles:[],password:$p,_rev:$r}')"
    else
        body="$(jq -nc --arg u "$username" --arg p "$password" \
            '{_id:("org.couchdb.user:"+$u),name:$u,type:"user",roles:[],password:$p}')"
    fi
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" \
        -X PUT "${url}" -H "Content-Type: application/json" \
        -d "$body" 2>&1 || true)"
    case "$code" in
        2*) log "  user '${username}' ready" ;;
        *) die "Failed to create/update user '${username}' (HTTP ${code})" ;;
    esac
}

for i in $(seq 0 $((LOGINS_COUNT - 1))); do
    username="$(login_field "$i" username)"
    [[ "$(login_field "$i" server_admin)" == "true" ]] && continue
    password="$(resolve_password "$username" "$(login_field "$i" password)")"
    ensure_user "$username" "$password"
done
rm -f /tmp/userdoc.json

# Rights map to per-database security objects: members read and write
# documents, db-admins additionally manage design documents. The server
# administrator bypasses both — that is the break-glass account.
apply_right() {
    local db="$1" username="$2" level="$3" security merged code
    [[ -n "${DB_SET[$db]:-}" ]] || die "rights references database '${db}' which is not in databases"
    security="$(curl -sS -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" \
        "${COUCH_URL}/$(printf '%s' "$db" | jq -sRr @uri)/_security" 2>/dev/null || echo '{}')"
    [[ "$(jq -r 'type' <<<"$security")" == "object" ]] || security='{}'
    # Options are leading on the LEVEL too: a user declared admin is removed
    # from members (and vice versa) so member<->admin changes converge on the
    # next start instead of accumulating. Role arrays (e.g. LiveSync's _admin)
    # are preserved untouched.
    merged="$(jq -c --arg u "$username" \
        --argjson admin "$([[ "$level" == "admin" ]] && echo true || echo false)" '
        def names_of($b): (($b // {}).names // []);
        def with_names($b; $n): {roles: (($b // {}).roles // []), names: $n};
        if $admin
        then
            .members //= {} | .members.names = ((names_of(.members)) - [$u])
            | .admins = with_names(.admins; ((names_of(.admins)) + [$u] | unique))
        else
            .admins //= {} | .admins.names = ((names_of(.admins)) - [$u])
            | .members = with_names(.members; ((names_of(.members)) + [$u] | unique))
        end' <<<"$security")"
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -u "${ADMIN_USERNAME}:${ADMIN_PASSWORD}" \
        -X PUT "${COUCH_URL}/$(printf '%s' "$db" | jq -sRr @uri)/_security" \
        -H "Content-Type: application/json" \
        -d "$merged" 2>&1 || true)"
    case "$code" in
        2*) log "  ${username} is ${level} of '${db}'" ;;
        *) die "Failed to apply right (${username} ${level} of ${db}, HTTP ${code})" ;;
    esac
}

for i in $(seq 0 $((RIGHTS_COUNT - 1))); do
    db="$(jq -r --argjson i "$i" '.rights[$i].database // empty' "$OPTIONS_JSON")"
    username="$(jq -r --argjson i "$i" '.rights[$i].username // empty' "$OPTIONS_JSON")"
    level="$(jq -r --argjson i "$i" '.rights[$i].level // "member"' "$OPTIONS_JSON")"
    [[ -n "$db" && -n "$username" ]] || die "rights[$i] needs database and username"
    apply_right "$db" "$username" "$level"
done

# ---------------------------------------------------------------------------
# Step 7: Agent docstore MCP endpoint (optional)
#
# Serves the registry-validated doc_* tools on an internal port plus the
# hourly TTL sweeper. The registry lives in /config so it can be edited
# without rebuilding the image.
# ---------------------------------------------------------------------------
if [[ "$DOCSTORE_ENABLED" == "true" ]]; then
    mkdir -p "$DOCSTORE_DIR"
    if [[ ! -f "${DOCSTORE_DIR}/registry.json" ]]; then
        cp /docstore/registry.default.json "${DOCSTORE_DIR}/registry.json"
        log "Installed default docstore registry at ${DOCSTORE_DIR}/registry.json"
    fi

    DOCSTORE_TOKEN="$(jq -r '.docstore.token // empty' "$OPTIONS_JSON")"
    if [[ -z "$DOCSTORE_TOKEN" ]]; then
        if [[ -f "${DOCSTORE_DIR}/mcp_token" ]]; then
            DOCSTORE_TOKEN="$(cat "${DOCSTORE_DIR}/mcp_token")"
        else
            DOCSTORE_TOKEN="$(openssl rand -base64 24)"
            (
                umask 077
                printf '%s' "$DOCSTORE_TOKEN" > "${DOCSTORE_DIR}/mcp_token"
            )
            warn "Generated docstore MCP token, saved to ${DOCSTORE_DIR}/mcp_token"
        fi
    fi
    jq -e --arg u "$DOCSTORE_USERNAME" '(.logins // []) | any(.username == $u)' \
        "$OPTIONS_JSON" > /dev/null \
        || die "docstore.username '${DOCSTORE_USERNAME}' has no matching login"

    # Resolve the docstore user's password the same way provisioning does:
    # options value, else the generated file. options.json alone would only
    # ever hold a blank for generated accounts (the 3.6.0 startup bug).
    DOCSTORE_PASSWORD="$(resolve_password "$DOCSTORE_USERNAME" \
        "$(jq -r --arg u "$DOCSTORE_USERNAME" \
            'first((.logins // [])[] | select(.username == $u) | .password // "") // ""' \
            "$OPTIONS_JSON")")"

    log "Starting docstore MCP endpoint on :${DOCSTORE_PORT} (internal only)"
    DOCSTORE_PORT="$DOCSTORE_PORT" DOCSTORE_TOKEN="$DOCSTORE_TOKEN" \
        DOCSTORE_USERNAME="$DOCSTORE_USERNAME" DOCSTORE_PASSWORD="$DOCSTORE_PASSWORD" \
        python3 /docstore/server.py &
    DOCSTORE_PID=$!
    log "Ready. Fauxton: http://<host>:5984/_utils (review docs as '${DOCSTORE_USERNAME}')"
else
    log "Docstore disabled (docstore.enabled=false)"
fi

# ---------------------------------------------------------------------------
# Step 8: Hand the container's lifetime back to CouchDB
# ---------------------------------------------------------------------------
trap - EXIT INT TERM
wait "$COUCH_PID"

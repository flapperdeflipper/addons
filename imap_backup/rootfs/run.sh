#!/usr/bin/env bash
# shellcheck shell=bash
set -Eeuo pipefail

# IMAP Backup: Dovecot as a plain IMAPS mailbox to copy mail into (Apple Mail:
# drag mailboxes or messages from another account onto this one). The Dovecot
# config is static (/etc/dovecot/dovecot.conf); this script only prepares what
# it points at, from /data/options.json:
#   * /mail -> /share/<storage_dir>, one Maildir home per account (owned by vmail)
#   * /run/imap_backup/passwd    accounts, SHA512-CRYPT hashed on every start
#   * /run/imap_backup/{cert,key}.pem   /ssl/<certfile> or a self-signed cert
#   * /run/imap_backup/debug.conf       only with `debug: true`
# then execs dovecot in the foreground.

OPTIONS_JSON="${OPTIONS_JSON:-/data/options.json}"
SHARE_DIR="${SHARE_DIR:-/share}"
SSL_DIR="${SSL_DIR:-/ssl}"
STATE_DIR="${STATE_DIR:-/data}"
RUN_DIR="/run/imap_backup"
MAIL_LINK="/mail"
VMAIL_UID=5000
VMAIL_GID=5000

# Self-signed certificates: macOS refuses TLS server certificates valid for more
# than 825 days, even when trusted by hand. Renewed when < 30 days are left.
SELF_SIGNED_DAYS=825
RENEW_SECONDS=$((30 * 24 * 3600))

USERNAME_RE='^[A-Za-z0-9][A-Za-z0-9._@+-]*$'
STORAGE_DIR_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
HOSTNAME_RE='^[A-Za-z0-9*]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
IPV4_RE='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'

log() { echo "[imap_backup] $*"; }
die() { echo "[imap_backup] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
[[ -f "${OPTIONS_JSON}" ]] || die "missing options file at ${OPTIONS_JSON}"

# Supervisor expands '!secret <key>' when it writes options.json. A value that is
# still a '!secret …' string means the key is missing from secrets.yaml.
if grep -q '"!secret ' "${OPTIONS_JSON}"; then
    refs="$(grep -o '"!secret [^"]*"' "${OPTIONS_JSON}" | sort -u | tr '\n' ' ' || true)"
    die "unresolved !secret reference in options: ${refs}"
fi

STORAGE_DIR="$(jq -r '.storage_dir // "imap_backup"' "${OPTIONS_JSON}")"
CERTFILE="$(jq -r '.certfile // ""' "${OPTIONS_JSON}")"
KEYFILE="$(jq -r '.keyfile // ""' "${OPTIONS_JSON}")"
DEBUG="$(jq -r '.debug // false' "${OPTIONS_JSON}")"
hostnames="$(jq -r '.hostnames // [] | .[]' "${OPTIONS_JSON}")"
HOSTNAMES=()
[[ -z "${hostnames}" ]] || mapfile -t HOSTNAMES <<< "${hostnames}"
ACCOUNT_COUNT="$(jq '.accounts // [] | length' "${OPTIONS_JSON}")"

[[ "${STORAGE_DIR}" =~ ${STORAGE_DIR_RE} ]] \
    || die "storage_dir '${STORAGE_DIR}' must be a single folder name under /share (A-Z a-z 0-9 . _ -)"
(( ACCOUNT_COUNT > 0 )) || die "accounts must list at least one account"

declare -A SEEN=()
for i in $(seq 0 $((ACCOUNT_COUNT - 1))); do
    username="$(jq -r --argjson i "${i}" '.accounts[$i].username // ""' "${OPTIONS_JSON}")"
    password="$(jq -r --argjson i "${i}" '.accounts[$i].password // ""' "${OPTIONS_JSON}")"
    [[ "${username}" =~ ${USERNAME_RE} ]] \
        || die "accounts[${i}]: username '${username}' is invalid (A-Z a-z 0-9 . _ @ + -, not starting with a symbol)"
    [[ -z "${SEEN[${username}]:-}" ]] || die "accounts: '${username}' is listed twice"
    [[ -n "${password}" ]] || die "accounts: '${username}' has no password; set one in the add-on configuration"
    SEEN["${username}"]=1
done

# ---------------------------------------------------------------------------
# Storage: /share/<storage_dir>/<username>/Maildir
# ---------------------------------------------------------------------------
[[ -d "${SHARE_DIR}" ]] || die "${SHARE_DIR} is not mounted"
mail_root="${SHARE_DIR}/${STORAGE_DIR}"
if [[ ! -d "${mail_root}" ]]; then
    install -d -m 0750 -o "${VMAIL_UID}" -g "${VMAIL_GID}" "${mail_root}"
    log "created ${mail_root}"
fi
ln -sfn "${mail_root}" "${MAIL_LINK}"
# Homes are only created, never chowned recursively: an archive can hold a
# million files, and nothing but Dovecot (as vmail) writes in there.
for username in "${!SEEN[@]}"; do
    if [[ ! -d "${mail_root}/${username}" ]]; then
        install -d -m 0700 -o "${VMAIL_UID}" -g "${VMAIL_GID}" "${mail_root}/${username}"
        log "created mailbox home for '${username}'"
    fi
done

# ---------------------------------------------------------------------------
# Accounts -> passwd-file (rebuilt on every start, so option changes apply)
# ---------------------------------------------------------------------------
install -d -m 0755 "${RUN_DIR}"
passwd_tmp="$(mktemp "${RUN_DIR}/.passwd.XXXXXX")"
for i in $(seq 0 $((ACCOUNT_COUNT - 1))); do
    username="$(jq -r --argjson i "${i}" '.accounts[$i].username' "${OPTIONS_JSON}")"
    # Password goes in on stdin, never on a command line.
    hash="$(jq -r --argjson i "${i}" '.accounts[$i].password' "${OPTIONS_JSON}" | openssl passwd -6 -stdin)"
    printf '%s:{SHA512-CRYPT}%s::::::\n' "${username}" "${hash}" >> "${passwd_tmp}"
done
chown root:dovecot "${passwd_tmp}"
chmod 0640 "${passwd_tmp}"
mv -f "${passwd_tmp}" "${RUN_DIR}/passwd"
log "${ACCOUNT_COUNT} account(s): ${!SEEN[*]}"

# ---------------------------------------------------------------------------
# TLS
# ---------------------------------------------------------------------------
self_signed() {
    local dir="${STATE_DIR}/ssl" names san="" name
    names="$(printf '%s\n' "${HOSTNAMES[@]}")"
    for name in "${HOSTNAMES[@]}"; do
        if [[ "${name}" =~ ${IPV4_RE} || "${name}" == *:* ]]; then
            san+="${san:+,}IP:${name}"
        elif [[ "${name}" =~ ${HOSTNAME_RE} ]]; then
            san+="${san:+,}DNS:${name}"
        else
            die "hostnames: '${name}' is not a hostname or IP address"
        fi
    done
    install -d -m 0700 "${dir}"
    local stored_names="" not_after
    [[ -f "${dir}/hostnames" ]] && stored_names="$(<"${dir}/hostnames")"
    if [[ -f "${dir}/cert.pem" && -f "${dir}/key.pem" && "${stored_names}" == "${names}" ]] \
        && openssl x509 -in "${dir}/cert.pem" -noout -checkend "${RENEW_SECONDS}" >/dev/null; then
        not_after="$(openssl x509 -in "${dir}/cert.pem" -noout -enddate || true)"
        log "TLS: self-signed certificate for ${HOSTNAMES[*]} (${not_after})"
    else
        log "TLS: generating a self-signed certificate for ${HOSTNAMES[*]} (valid ${SELF_SIGNED_DAYS} days)"
        (
            umask 077
            openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
                -keyout "${dir}/key.pem.new" -out "${dir}/cert.pem.new" \
                -days "${SELF_SIGNED_DAYS}" -subj "/CN=${HOSTNAMES[0]}" \
                -addext "subjectAltName=${san}" \
                -addext "basicConstraints=critical,CA:FALSE" \
                -addext "keyUsage=critical,digitalSignature" \
                -addext "extendedKeyUsage=serverAuth" 2>/dev/null
        ) || die "TLS: generating the self-signed certificate failed"
        mv -f "${dir}/key.pem.new" "${dir}/key.pem"
        mv -f "${dir}/cert.pem.new" "${dir}/cert.pem"
        printf '%s\n' "${names}" > "${dir}/hostnames"
        log "TLS: mail clients will ask to trust the new certificate once"
    fi
    ln -sfn "${dir}/cert.pem" "${RUN_DIR}/cert.pem"
    ln -sfn "${dir}/key.pem" "${RUN_DIR}/key.pem"
}

if [[ -n "${CERTFILE}" || -n "${KEYFILE}" ]]; then
    [[ -n "${CERTFILE}" && -n "${KEYFILE}" ]] || die "set both certfile and keyfile, or neither for a self-signed certificate"
    [[ -f "${SSL_DIR}/${CERTFILE}" ]] || die "certfile ${SSL_DIR}/${CERTFILE} not found"
    [[ -f "${SSL_DIR}/${KEYFILE}" ]] || die "keyfile ${SSL_DIR}/${KEYFILE} not found"
    ln -sfn "${SSL_DIR}/${CERTFILE}" "${RUN_DIR}/cert.pem"
    ln -sfn "${SSL_DIR}/${KEYFILE}" "${RUN_DIR}/key.pem"
    log "TLS: ${SSL_DIR}/${CERTFILE}"
else
    (( ${#HOSTNAMES[@]} > 0 )) || die "hostnames must list at least one name for the self-signed certificate"
    self_signed
fi

# ---------------------------------------------------------------------------
# Debug logging
# ---------------------------------------------------------------------------
if [[ "${DEBUG}" == "true" ]]; then
    printf '%s\n' 'auth_verbose = yes' 'log_debug = category=auth OR category=imap OR category=mail' \
        > "${RUN_DIR}/debug.conf"
    log "debug logging on"
else
    rm -f "${RUN_DIR}/debug.conf"
fi

doveconf -n >/dev/null || die "dovecot configuration is invalid (see above)"
log "serving IMAPS on port 993, mail in ${mail_root}"
exec dovecot -F

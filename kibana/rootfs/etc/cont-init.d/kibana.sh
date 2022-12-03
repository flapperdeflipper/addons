#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e -o pipefail +x

CONFIG_PATH=/data/options.json
KIBANA_CONFIG=/etc/kibana/kibana.yml

function setconf() {
    key="${2}"
    value="${4}"
    sed -i "s|%%${key}%%|${value}|g" "${KIBANA_CONFIG}"
}

function main() {
    bashio::log.info "Initializing kibana configuration."

    ## Set default config if not found
    if ! bashio::fs.file_exists "/share/kibana/kibana.yml"
    then
        bashio::log.info "Creating default config file"
        cp /usr/share/kibana/kibana.yml.tmpl /share/kibana/kibana.yml
    fi

    ## Copy default config to /etc/kibana
    cp /share/kibana/kibana.yml "${KIBANA_CONFIG}"

    ## Update config file
    setconf --key elasticsearch_host     --value "$( bashio::config elasticsearch.host )"
    setconf --key elasticsearch_username --value "$( bashio::config elasticsearch.username )"
    setconf --key elasticsearch_password --value "$( bashio::config elasticsearch.password )"

    bashio::log.info "Finished updating kibana config file."
}

main "${@}"

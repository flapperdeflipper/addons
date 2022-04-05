#!/usr/bin/with-contenv bashio
# vi: ft=bash
# shellcheck shell=bash

set -e -o pipefail +x

bashio::log.info "Initializing service configuration."

CONFIG_PATH=/data/options.json

## Unifi settings
UNIFI_HOST="$( bashio::config unifi_host )"
UNIFI_PORT="$( bashio::config unifi_port )"
UNIFI_USER="$( bashio::config unifi_user )"
UNIFI_PASS="$( bashio::config unifi_pass )"
INSECURE="$(   bashio::config insecure )"

## MQTT settings
if bashio::config.true 'mqtt_autoconfig' ; then
    bashio::log.info "Using autoconfig provided MQTT credentials from supervisor"

    MQTT_HOST="$( bashio::services mqtt 'host' )"
    MQTT_PORT="$( bashio::services mqtt 'port' )"
    MQTT_USER="$( bashio::services mqtt 'username' )"
    MQTT_PASS="$( bashio::services mqtt 'password' )"
else
    bashio::log.info "Using manually provided MQTT credentials"

    MQTT_HOST="$( bashio::config 'mqtt.host' )"
    MQTT_PORT="$( bashio::config 'mqtt.port' )"
    MQTT_USER="$( bashio::config 'mqtt.username' )"
    MQTT_PASS="$( bashio::config 'mqtt.password' )"
fi

MQTT_PREFIX="$( jq --raw-output '.mqtt.prefix // "home/unifi2mqtt"' $CONFIG_PATH )"

## Logging
LOGGING="$( jq --raw-output '.verbosity // "info"' $CONFIG_PATH )"

bashio::log.info "Creating startup script"

cat > /run.sh <<EOF
#!/usr/bin/env bash
set -e -o pipefail
export UNIFI__HOST="https://${UNIFI_HOST}:${UNIFI_PORT}"
export UNIFI__USERNAME="${UNIFI_USER}"
export UNIFI__PASSWORD="${UNIFI_PASS}"
export UNIFI__DISABLESSLVALIDATION="${INSECURE}"
export UNIFI__MQTT__TOPICPREFIX="${MQTT_PREFIX}"
export UNIFI__MQTT__DISCOVERYENABLED=true
export UNIFI__MQTT__DISCOVERYNAME=unifi2mqtt
export UNIFI__MQTT__BROKER="${MQTT_HOST}:${MQTT_PORT}"
export UNIFI__MQTT__USERNAME="${MQTT_USER}"
export UNIFI__MQTT__PASSWORD="${MQTT_PASS}"

exec /usr/bin/dotnet /app/Unifi.dll
EOF

chmod +x /run.sh

#!/usr/bin/with-contenv bashio
set -e -o pipefail +x

bashio::log.info "Initializing service configuration."

CONFIG_PATH=/data/options.json

## Unifi settings
UNIFI_HOST="$( bashio::config 'unifi_host' )"
UNIFI_PORT="$( bashio::config 'unifi_port' )"
UNIFI_USER="$( bashio::config 'unifi_user' )"
UNIFI_PASS="$( bashio::config 'unifi_pass' )"
UNIFI_SITE="$( bashio::config 'unifi_site' )"
INSECURE="$( bashio::config 'insecure')"

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

MQTT_URL="mqtt://${MQTT_USER}:${MQTT_PASS}@${MQTT_HOST}:${MQTT_PORT}"
MQTT_PREFIX="$( jq --raw-output '.mqtt.prefix // "home/unifi2mqtt"' $CONFIG_PATH )"

## Logging
LOGGING="$( jq --raw-output '.verbosity // "info"' $CONFIG_PATH )"

## Command
COMMAND=(
    "unifi2mqtt"
    "--unifi-host"     "${UNIFI_HOST}"
    "--unifi-port"     "${UNIFI_PORT}"
    "--unifi-user"     "${UNIFI_USER}"
    "--unifi-password" "${UNIFI_PASS}"
    "--unifi-site"     "${UNIFI_SITE}"
    "--verbosity"      "${LOGGING}"
    "--name"           "${MQTT_PREFIX}"
    "--url"            "${MQTT_URL}"
)

if [ "${INSECURE}" == "true" ] ; then
   COMMAND+=("--insecure" "${INSECURE}")
fi

bashio::log.info "Creating startup script"

cat | tee /run.sh <<EOF
#!/usr/bin/env bash
set -e -o pipefail
exec ${COMMAND[@]}"
EOF

chmod +x /run.sh

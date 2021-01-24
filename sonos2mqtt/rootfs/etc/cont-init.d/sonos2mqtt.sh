#!/usr/bin/with-contenv bashio
set -e -o pipefail

bashio::log.info "Initializing service configuration."

CONFIG_PATH=/data/options.json

if bashio::config.true 'mqtt_autoconfig' ; then
    bashio::log.info "Using autoconfig provided MQTT credentials from supervisor"

    export MQTT_HOST="$( bashio::services mqtt 'host' )"
    export MQTT_PORT="$( bashio::services mqtt 'port' )"
    export MQTT_USER="$( bashio::services mqtt 'username' )"
    export MQTT_PASS="$( bashio::services mqtt 'password' )"
else
    bashio::log.info "Using manually provided MQTT credentials"

    export MQTT_HOST="$( bashio::config 'mqtt.host' )"
    export MQTT_PORT="$( bashio::config 'mqtt.port' )"
    export MQTT_USER="$( bashio::config 'mqtt.username' )"
    export MQTT_PASS="$( bashio::config 'mqtt.password' )"
fi

export MQTT_CLIENT_ID="$( jq --raw-output '.mqtt.client_id // "sonos2mqtt"' $CONFIG_PATH )"
export MQTT_TOPIC_PREFIX="$( jq --raw-output '.mqtt.prefix // "home/sonos2mqtt"' $CONFIG_PATH )"

## Sonos config
export SONOS_DEVICE_IP="$( jq --raw-output '.device' $CONFIG_PATH )"
export FRIENDLY_NAMES="$( jq --raw-output '.friendly_names // "name"' $CONFIG_PATH )"
export DISTINCT="$( jq --raw-output '.distinct // true' $CONFIG_PATH )"

## TTS
export TTS_LANG="$( jq --raw-output '.tts_lang // "en-US"' $CONFIG_PATH )"
export TTS_ENDPOINT="$( jq --raw-output '.tts_endpoint // empty' $CONFIG_PATH )"

## Discovery
export DISCOVERY="$( jq --raw-output '.discovery // false' $CONFIG_PATH )"
export DISCOVERY_PREFIX="$( jq --raw-output '.discovery_prefix // "homeassistant"' $CONFIG_PATH )"

## Logging
export LOGGING="$( jq --raw-output '.log_level // "information"' $CONFIG_PATH )"

# ======================================
# Create config file
# ======================================

[ -d /etc/sonos2mqtt ] || mkdir -p /etc/sonos2mqtt

if [ -f /data/sonos2mqtt.json ] ; then
    bashio::log.info "Found sonos2mqtt config in data: Copy in place to /etc/sonos2mqtt/config.json"
    cp /data/sonos2mqtt.json /etc/sonos2mqtt/config.json
else
    if [ ! -f /etc/config.tpl ] ; then
       bashio::log.error "Template configuration file not found!"
       exit 1
    fi

    bashio::log.info "Generating sonos2mqtt config to /etc/sonos2mqtt/config.json"

    envsubst < /etc/config.tpl >> /etc/sonos2mqtt/config.json

    bashio::log.info "Finished generating a configuration file in /etc/sonos2mqtt/config.json"
fi

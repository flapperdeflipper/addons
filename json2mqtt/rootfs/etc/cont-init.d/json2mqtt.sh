#!/usr/bin/with-contenv bashio
set -e -o pipefail +x

bashio::log.info "Initializing service configuration."

CONFIG_PATH=/data/options.json

################################################################################
## MQTT settings                                                              ##
################################################################################

if bashio::config.true mqtt_autoconfig ; then
    bashio::log.info "Using autoconfig provided MQTT credentials from supervisor"

    MQTT_HOST="$( bashio::services mqtt host )"
    MQTT_PORT="$( bashio::services mqtt port )"
    MQTT_USER="$( bashio::services mqtt username )"
    MQTT_PASS="$( bashio::services mqtt password )"
else
    bashio::log.info "Using manually provided MQTT credentials"

    MQTT_HOST="$( bashio::config mqtt.host )"
    MQTT_PORT="$( bashio::config mqtt.port )"
    MQTT_USER="$( bashio::config mqtt.username )"
    MQTT_PASS="$( bashio::config mqtt.password )"
fi

MQTT_SSL="$(   bashio::config mqtt.ssl )"
MQTT_CERT="$(  bashio::config mqtt.ssl_cert )"
MQTT_PREFIX="$( bashio::config mqtt.prefix  )"

################################################################################
## Logging                                                                    ##
################################################################################

bashio::log.info "Setting up logging"

VERBOSITY="$(  bashio::config verbosity )"

if [[ "$VERBOSITY" == "error" ]] ; then
    LOG_ARGS="-v"
elif [[ "$VERBOSITY" == "info" ]] ; then
    LOG_ARGS="-vv"
elif [[ "$VERBOSITY" == "debug" ]] ; then
    LOG_ARGS="-vvv"
else
    LOG_ARGS="-vv"
fi

################################################################################
## Schemas                                                                    ##
################################################################################

bashio::log.info "Setting up schemas"

SCHEMA_DIR="$( bashio::config schema_dir )"
test -d /share/json2mqtt/schemas || mkdir -p /share/json2mqtt/schemas

################################################################################
## Settings                                                                   ##
################################################################################

bashio::log.info "Creating settings file"

cat > /share/json2mqtt/settings.yaml <<EOF
---
mqtt_host: "${MQTT_HOST}"
mqtt_port: ${MQTT_PORT}
mqtt_username: "${MQTT_USER}"
mqtt_password: "${MQTT_PASS}"
mqtt_ssl: ${MQTT_SSL}
mqtt_cert: "${MQTT_CERT}"
mqtt_topic: "${MQTT_PREFIX}"
schema_dir: "${SCHEMA_DIR}"
...
EOF

################################################################################
## Schemas                                                                    ##
################################################################################

export TOON_HOST="$( bashio::config toon_host )"

for template in /usr/share/schemas/*.json
do
    filename="$( basename "${template}" )"
    schema="/share/json2mqtt/schemas/${filename}"

    cat "${template}" | envsubst > "$schema"
done

################################################################################
## Startup script                                                             ##
################################################################################

bashio::log.info "Creating startup script"

cat > /run.sh <<EOF
#!/usr/bin/env bash
set -e -o pipefail
exec json2mqtt --config /share/json2mqtt/settings.yaml ${LOG_ARGS}
EOF

chmod +x /run.sh

################################################################################
## EOF                                                                        ##
################################################################################

#!/usr/bin/env bashio
set +u

################################################################################
## Variables                                                                  ##
################################################################################

CONFIG_PATH=/data/options.json
SYSTEM_USER=/data/system_user.json

ANONYMOUS="$( jq --raw-output '.anonymous // false' $CONFIG_PATH )"
KEYFILE="$( jq --raw-output '.keyfile // empty' $CONFIG_PATH )"
CERTFILE="$( jq --raw-output '.certfile // empty' $CONFIG_PATH )"
REQUIRE_CERTIFICATE="$( jq --raw-output '.require_certificate // false' $CONFIG_PATH )"
CUSTOMIZE_ACTIVE="$( jq --raw-output '.customize.active // false' $CONFIG_PATH )"
CAFILE="$( jq --raw-output --exit-status ".cafile | select (.!=null)" $CONFIG_PATH || echo "$CERTFILE" )"

LOGGING="$( bashio::info 'hassio.info.logging' '.logging' )"

WAIT_PIDS=()

SSL_CONFIG="
listener 8883
protocol mqtt
cafile /ssl/$CAFILE
certfile /ssl/$CERTFILE
keyfile /ssl/$KEYFILE
require_certificate $REQUIRE_CERTIFICATE

listener 8884
protocol websockets
cafile /ssl/$CAFILE
certfile /ssl/$CERTFILE
keyfile /ssl/$KEYFILE
require_certificate $REQUIRE_CERTIFICATE
"

MYSQL_USER="$( bashio::services 'mysql' 'username' )"
MYSQL_PASS="$( bashio::services 'mysql' 'password' )"
MYSQL_HOST="$( bashio::services 'mysql' 'host' )"
MYSQL_PORT="$( bashio::services 'mysql' 'port' )"

################################################################################
## Functions                                                                  ##
################################################################################

function get_database() {
    mysql \
        -u "${MYSQL_USER}" \
        -p"${MYSQL_PASS}"  \
        -h "${MYSQL_HOST}" \
        -P "${MYSQL_PORT}" \
        --skip-column-names    \
        -e 'SHOW DATABASES LIKE "mosquitto"'
}

function create_database() {
    mysql \
        -u "${MYSQL_USER}" \
        -p"${MYSQL_PASS}"  \
        -h "${MYSQL_HOST}" \
        -P "${MYSQL_PORT}" \
        --skip-column-names    \
        -e 'CREATE DATABASE mosquitto'
}


function load_database() {
    local admin_password="$1"
    local hass_password="$2"
    local addons_password="$3"

    sed -i -e "s|%%ADMIN_PASSWORD%%|$admin_password|g"   /usr/share/create_tables.sql
    sed -i -e "s|%%HASS_PASSWORD%%|$hass_password|g"     /usr/share/create_tables.sql
    sed -i -e "s|%%ADDONS_PASSWORD%%|$addons_password|g" /usr/share/create_tables.sql

    mysql "mosquitto" \
        -u "${MYSQL_USER}" \
        -p"${MYSQL_PASS}"  \
        -h "${MYSQL_HOST}" \
        -P "${MYSQL_PORT}" < /usr/share/create_tables.sql
}


function update_admin_passwords() {
    local admin_password="$1"
    local hass_password="$2"
    local addons_password="$3"

    mysql "mosquitto" \
        -u "${MYSQL_USER}"  \
        -p"${MYSQL_PASS}"   \
        -h "${MYSQL_HOST}"  \
        -P "${MYSQL_PORT}"  \
        --skip-column-names \
        -e "
    UPDATE users
      SET pw = (
        case
          when username = 'admin'
          then '${admin_password}'
          when username = 'homeassistant'
          then '${hass_password}'
          when username = 'addons'
          then '${addons_password}'
        end
      )
      WHERE username in ('admin' 'homeassistant', 'addons')
    "
}

function write_system_users() {
    local hass="$1"
    local addons="$2"
    local admin="$3"
    (
        echo "{\"homeassistant\": {\"password\": \"$hass\"}, \"addons\": {\"password\": \"$addons\"}, \"admin\": {\"password\": \"$admin\"}}"
    ) > "${SYSTEM_USER}"
}

function call_hassio() {
    local method=$1
    local path=$2
    local data="${3}"
    local token=

    token="X-Hassio-Key: ${HASSIO_TOKEN}"
    url="http://hassio/${path}"

    # Call API
    if [ -n "${data}" ]; then
        curl -f -s -X "${method}" -d "${data}" -H "${token}" "${url}"
    else
        curl -f -s -X "${method}" -H "${token}" "${url}"
    fi

    return $?
}

function constrain_host_config() {
    local user=$1
    local password=$2

    echo "{"
    echo "  \"host\": \"$(hostname)\","
    echo "  \"port\": 1883,"
    echo "  \"ssl\": false,"
    echo "  \"protocol\": \"3.1.1\","
    echo "  \"username\": \"${user}\","
    echo "  \"password\": \"${password}\""
    echo "}"
}

function constrain_discovery() {
    local user=$1
    local password=$2
    local config=

    config="$( constrain_host_config "${user}" "${password}" )"

    echo "{"
    echo "  \"service\": \"mqtt\","
    echo "  \"config\": ${config}"
    echo "}"
}


function update_mosquitto_config() {
    ## Allow anonymous logins
    sed -i -e "s|%%ANONYMOUS%%|$ANONYMOUS|g" /etc/mosquitto.conf

    ## Setup logging
    sed -i -e "s|%%AUTH_QUIET_LOGS%%|$LOGGING|g" /etc/mosquitto.conf

    ## Setup mysql credentials
    sed -i -e "s|%%MYSQL_USER%%|$MYSQL_USER|g" /etc/mosquitto.conf
    sed -i -e "s|%%MYSQL_PASS%%|$MYSQL_PASS|g" /etc/mosquitto.conf
    sed -i -e "s|%%MYSQL_HOST%%|$MYSQL_HOST|g" /etc/mosquitto.conf
    sed -i -e "s|%%MYSQL_PORT%%|$MYSQL_PORT|g" /etc/mosquitto.conf

    # Enable SSL if exists configs
    if [ -e "/ssl/$CAFILE" ] && [ -e "/ssl/$CERTFILE" ] && [ -e "/ssl/$KEYFILE" ]; then
        bashio::log.info "Setup mosquitto TLS configuration"
        echo "$SSL_CONFIG" >> /etc/mosquitto.conf
    else
        bashio::log.warning "SSL not enabled - No valid certs found!"
    fi

    # Allow customize configs from share
    if [ "$CUSTOMIZE_ACTIVE" == "true" ]; then
        CUSTOMIZE_FOLDER=$(jq --raw-output '.customize.folder // "/dev/null"' $CONFIG_PATH)
        sed -i "s|#include_dir .*|include_dir /share/$CUSTOMIZE_FOLDER|g" /etc/mosquitto.conf
    fi
}

################################################################################
## Prepare System Accounts                                                    ##
################################################################################

if [ ! -e "${SYSTEM_USER}" ]; then
    bashio::log.info "Generate system user passwords."

    HASS_PASSWORD="$( pwgen 64 1 )"
    ADDONS_PASSWORD="$( pwgen 64 1 )"
    ADMIN_PASSWORD="$( jq --raw-output '.admin_password' $CONFIG_PATH )"

    bashio::log.info "Initialize system users configuration."
    write_system_users "$HASS_PASSWORD" "$ADDONS_PASSWORD" "$ADMIN_PASSWORD"
else
    HASS_PASSWORD=$(jq --raw-output '.homeassistant.password' $SYSTEM_USER)
    ADDONS_PASSWORD=$(jq --raw-output '.addons.password' $SYSTEM_USER)
    ADMIN_PASSWORD="$( jq --raw-output '.admin.password' $SYSTEM_USER)"
fi

################################################################################
## Create database                                                            ##
################################################################################

DATABASE="$( get_database )"
HASS_PASSWORD_HASH="$( pw -p "${HASS_PASSWORD}" )"
ADDONS_PASSWORD_HASH="$( pw -p "${ADDONS_PASSWORD}" )"
ADMIN_PASSWORD_HASH="$( pw -p "${ADMIN_PASSWORD}" )"

if ! bashio::var.has_value "${DATABASE}"; then
    bashio::log.info "Creating database for mosquitto"
    create_database

    bashio::log.info "Creating schema for mosquitto database"
    load_database "${ADMIN_PASSWORD_HASH}" "${HASS_PASSWORD_HASH}" "${ADDONS_PASSWORD_HASH}"

else
    bashio::log.info "Updating passwords for admin, homeassistant and addons"
    update_admin_passwords "${ADMIN_PASSWORD_HASH}" "${HASS_PASSWORD_HASH}" "${ADDONS_PASSWORD_HASH}"
fi

################################################################################
## Create mosquitto config file                                               ##
################################################################################

if [ -f /data/mosquitto.conf ] ; then
    bashio::log.info "Found mosquitto config in data: Copy in place to /etc/mosquitto.conf"
    cp /data/mosquitto.conf /etc/mosquitto.conf
else
    bashio::log.info "Generating mosquitto config to /etc/mosquitto.conf"
    update_mosquitto_config
fi

################################################################################
# Service registration                                                        ##
################################################################################

if call_hassio GET "services/mqtt" | jq --raw-output ".data.host" | grep -v "$(hostname)" > /dev/null; then
    bashio::log.warning "There is already an MQTT service running!"
else
    bashio::log.info "Initialize Home Assistant Add-on mqtt service"

    if ! call_hassio POST "services/mqtt" "$(constrain_host_config addons "${ADDONS_PASSWORD}")" > /dev/null; then
        bashio::log.error "Can't setup Home Assistant service mqtt"
    fi

    bashio::log.info "Initialize Home Assistant discovery"
    if ! call_hassio POST "discovery" "$(constrain_discovery homeassistant "${HASS_PASSWORD}")" > /dev/null; then
        bashio::log.error "Can't setup Home Assistant discovery mqtt"
    fi
fi

################################################################################
## Start daemon                                                               ##
################################################################################

bashio::log.info "Starting Mosquitto daemon"

# Start Mosquitto Server
runuser --user mosquitto -- mosquitto -c /etc/mosquitto.conf &
WAIT_PIDS+=($!)

################################################################################
## Handling Closing                                                           ##
################################################################################

function stop_mqtt() {
    bashio::log.info "Shutting down mqtt system"
    kill -15 "${WAIT_PIDS[@]}"

    # Remove service
    if call_hassio GET "services/mqtt" | jq --raw-output ".data.host" | grep "$(hostname)" > /dev/null; then
        if ! call_hassio DELETE "services/mqtt"; then
            bashio::log.warning "Service unregister fails!"
        fi
    fi

    wait "${WAIT_PIDS[@]}"
}
trap "stop_mqtt" SIGTERM SIGHUP

# Wait and hold Add-on running
wait "${WAIT_PIDS[@]}"

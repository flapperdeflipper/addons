ARG BUILD_FROM
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION
ARG GO_VERSION

################################################################################
## Step 1: Build mosquitto and the go auth plugin                             ##
################################################################################

FROM golang:${GO_VERSION}-bullseye AS builder
ARG MOSQUITTO_VERSION
ARG MOSQUITTO_AUTH_VERSION
ARG CJSON_VERSION
ARG LWS_VERSION

WORKDIR /app

RUN set -x \
 && apt-get update \
 && apt-get install -y \
     cmake \
     libc-ares2 \
     libc-ares-dev \
     libssl-dev \
     openssl \
     uuid \
     uuid-dev \
     wget \
     build-essential \
     git \
 \
 && wget -q https://github.com/warmcat/libwebsockets/archive/v${LWS_VERSION}.tar.gz -O /tmp/lws.tar.gz \
 && mkdir -p /app/lws \
 && tar --strip=1 -xf /tmp/lws.tar.gz -C /app/lws \
 && rm /tmp/lws.tar.gz \
 && cd /app/lws \
 && cmake . \
     -DCMAKE_BUILD_TYPE=MinSizeRel \
     -DCMAKE_INSTALL_PREFIX=/usr \
     -DLWS_IPV6=ON \
     -DLWS_WITHOUT_BUILTIN_GETIFADDRS=ON \
     -DLWS_WITHOUT_CLIENT=ON \
     -DLWS_WITHOUT_EXTENSIONS=ON \
     -DLWS_WITHOUT_TESTAPPS=ON \
     -DLWS_WITH_SHARED=OFF \
     -DLWS_WITH_ZIP_FOPS=OFF \
     -DLWS_WITH_ZLIB=OFF \
 && make -j "$( nproc )" \
 && rm -rf /root/.cmake \
 \
 && wget -q https://github.com/DaveGamble/cJSON/archive/v${CJSON_VERSION}.tar.gz -O /tmp/cjson.tar.gz \
 && mkdir -p /app/cjson \
 && tar --strip=1 -xf /tmp/cjson.tar.gz -C /app/cjson \
 && rm /tmp/cjson.tar.gz \
 && cd /app/cjson \
 && cmake . \
     -DCMAKE_BUILD_TYPE=MinSizeRel \
     -DBUILD_SHARED_AND_STATIC_LIBS=OFF \
     -DBUILD_SHARED_LIBS=OFF \
     -DCJSON_BUILD_SHARED_LIBS=OFF \
     -DCJSON_OVERRIDE_BUILD_SHARED_LIBS=OFF \
     -DCMAKE_INSTALL_PREFIX=/usr \
 && make -j "$(nproc)" \
 && rm -rf /root/.cmake \
 \
 && wget -q https://mosquitto.org/files/source/mosquitto-${MOSQUITTO_VERSION}.tar.gz -O /tmp/mosq.tar.gz \
 && mkdir -p /app/mosq \
 && tar --strip=1 -xf /tmp/mosq.tar.gz -C /app/mosq \
 && rm /tmp/mosq.tar.gz \
 && make -C /app/mosq -j "$(nproc)" \
     CFLAGS="-Wall -O2 -I/app/lws/include -I/app" \
     LDFLAGS="-L/app/lws/lib -L/app/cjson" \
     WITH_ADNS=no \
     WITH_DOCS=no \
     WITH_SHARED_LIBRARIES=yes \
     WITH_STATIC_LIBRARIES=no \
     WITH_SRV=no \
     WITH_STRIP=yes \
     WITH_TLS_PSK=no \
     WITH_WEBSOCKETS=yes \
     prefix=/usr \
     binary \
 \
 && wget -q https://github.com/iegomez/mosquitto-go-auth/archive/${MOSQUITTO_AUTH_VERSION}.tar.gz -qO /tmp/plugin.tgz \
 && mkdir -p /app/plugin \
 && tar --strip=1 -xf /tmp/plugin.tgz -C /app/plugin \
 && rm /tmp/plugin.tgz \
 && cd /app/plugin \
 && export CGO_CFLAGS="-I/usr/lib/include -I/usr/local/include -I/app/mosq/lib -I/app/mosq/src -I /app/mosq/include -fPIC" \
 && export CGO_LDFLAGS="-shared" \
 && make -j "$( nproc )"


################################################################################
## Step 2: Build the addon container                                          ##
################################################################################

FROM ${BUILD_FROM}

RUN set -x \
 && apt-get update \
 && apt-get install -y \
     ca-certificates \
     libc-ares2 \
     openssl \
     uuid \
     curl \
     mariadb-client \
     pwgen \
     util-linux \
 \
 && mkdir -p /usr/share/mosquitto \
 && addgroup --system --gid 1883 mosquitto \
 && adduser  --system --uid 1883 --home /var/empty --shell /sbin/nologin --ingroup mosquitto mosquitto

## Copy mosquitto client utils
COPY --from=builder /app/mosq/client/mosquitto_pub /usr/bin/mosquitto_pub
COPY --from=builder /app/mosq/client/mosquitto_rr  /usr/bin/mosquitto_rr
COPY --from=builder /app/mosq/client/mosquitto_sub /usr/bin/mosquitto_sub

## Copy mosquitto apps
COPY --from=builder /app/mosq/apps/mosquitto_ctrl/mosquitto_ctrl     /usr/bin/mosquitto_ctrl
COPY --from=builder /app/mosq/apps/mosquitto_passwd/mosquitto_passwd /usr/bin/mosquitto_passwd
COPY --from=builder /app/mosq/apps/db_dump/mosquitto_db_dump         /usr/bin/mosquitto_db_dump

## Copy libs and plugins
COPY --from=builder /app/mosq/lib/libmosquitto.so.1 /usr/lib/libmosquitto.so.1
COPY --from=builder /app/mosq/plugins/dynamic-security/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so
COPY --from=builder /app/mosq/plugins/auth-by-ip/mosquitto_auth_by_ip.so /usr/lib/mosquitto_auth_by_ip.so
COPY --from=builder /app/mosq/plugins/message-timestamp/mosquitto_message_timestamp.so /usr/lib/mosquitto_message_timestamp.so
COPY --from=builder /app/mosq/plugins/payload-modification/mosquitto_payload_modification.so /usr/lib/mosquitto_payload_modification.so

## Copy mosquitto daemon
COPY --from=builder /app/mosq/src/mosquitto /usr/sbin/mosquitto

## Copy auth plugin and utils
COPY --from=builder /app/plugin/go-auth.so /usr/share/mosquitto/auth-plug.so
COPY --from=builder /app/plugin/pw         /usr/bin/pw

WORKDIR /
COPY rootfs /

LABEL \
    io.hass.name="Moquitto" \
    io.hass.description="An Open Source MQTT broker" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.title="Mosquitto" \
    org.opencontainers.image.description="An Open Source MQTT broker" \
    org.opencontainers.image.vendor="Flipkes Home Assistant Add-ons" \
    org.opencontainers.image.authors="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://addons.fliphess.com" \
    org.opencontainers.image.source="https://github.com/flapperdeflipper/home-assistant-addons" \
    org.opencontainers.image.documentation="https://github.com/flapperdeflipper/home-assistant-addons/blob/master/mosquitto/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

USER root
EXPOSE 1883 1884 8883 8884

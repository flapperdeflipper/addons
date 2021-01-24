ARG BUILD_FROM
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION
ARG GO_VERSION


################################################################################
## Step 1: Build mosquitto and the go auth plugin                             ##
################################################################################

FROM golang:${GO_VERSION}-buster AS builder
ARG MOSQUITTO_VERSION
ARG MOSQUITTO_AUTH_VERSION

WORKDIR /app

RUN set -x \
 && apt-get update \
 && apt-get install -y \
        libwebsockets8 \
        libwebsockets-dev \
        libc-ares2 \
        libc-ares-dev \
        openssl \
        uuid \
        uuid-dev \
        wget \
        build-essential \
        git \
 \
 && wget https://mosquitto.org/files/source/mosquitto-${MOSQUITTO_VERSION}.tar.gz -qO /tmp/mosq.tar.gz \
 && mkdir -p /app/mosq \
 && tar --strip=1 -xf /tmp/mosq.tar.gz -C /app/mosq \
 && rm /tmp/mosq.tar.gz \
 && make -C /app/mosq -j "$( nproc )" \
        WITH_ADNS=no \
        WITH_DOCS=no \
        WITH_SHARED_LIBRARIES=yes \
        WITH_STATIC_LIBRARIES=no \
        WITH_SRV=no \
        WITH_STRIP=yes \
        WITH_WEBSOCKETS=yes \
        prefix=/usr \
        binary \
 \
 && wget https://github.com/iegomez/mosquitto-go-auth/archive/${MOSQUITTO_AUTH_VERSION}.tar.gz -qO /tmp/plugin.tgz \
 && mkdir -p /app/plugin \
 && tar --strip=1 -xf /tmp/plugin.tgz -C /app/plugin \
 && cd /app/plugin \
 && export CGO_CFLAGS="-I/usr/lib/include -I/usr/local/include -I/app/mosq/lib -I/app/mosq/src -fPIC" \
 && export CGO_LDFLAGS="-shared" \
 && make -j "$( nproc )"


################################################################################
## Step 2: Build the addon container                                          ##
################################################################################

FROM $BUILD_FROM
RUN apt-get update \
 && apt-get install -y \
        libwebsockets8 \
        libc-ares2 \
        openssl \
        uuid \
        curl \
        mariadb-client \
        pwgen

RUN mkdir -p /usr/share/mosquitto \
 && addgroup --system --gid 1883 mosquitto \
 && adduser --system -u 1883  --home /var/empty --shell /sbin/nologin --ingroup mosquitto  mosquitto

COPY --from=builder /app/mosq/client/mosquitto_pub  /usr/bin/mosquitto_pub
COPY --from=builder /app/mosq/client/mosquitto_rr   /usr/bin/mosquitto_rr
COPY --from=builder /app/mosq/client/mosquitto_sub  /usr/bin/mosquitto_sub
COPY --from=builder /app/mosq/src/mosquitto_passwd  /usr/bin/mosquitto_passwd
COPY --from=builder /app/mosq/src/mosquitto         /usr/sbin/mosquitto
COPY --from=builder /app/mosq/lib/libmosquitto.so.1 /usr/lib/libmosquitto.so.1
COPY --from=builder /app/plugin/go-auth.so          /usr/share/mosquitto/auth-plug.so
COPY --from=builder /app/plugin/pw                  /usr/bin/pw

WORKDIR /

COPY data/run.sh /
COPY data/create_tables.sql /usr/share/
COPY data/mosquitto.conf /etc/

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
    org.opencontainers.image.source="https://github.com/fliphess/home-assistant-addons" \
    org.opencontainers.image.documentation="https://github.com/fliphess/home-assistant-addons/blob/master/mosquitto/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

USER root
EXPOSE 1883 1884 8883 8884
CMD [ "/run.sh" ]


ARG BUILD_FROM
FROM $BUILD_FROM

ARG JSON2MQTT_VERSION="1.1.0"

ENV LANG C.UTF-8

RUN apk add --no-cache --virtual .build-dependencies \
      py3-pip \
 \
 && apk add --no-cache \
      gettext \
      python3 \
      curl \
      jq \
 \
 && apk add runuser --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main \
 && pip3 install --disable-pip-version-check --no-cache-dir  --upgrade json2mqtt \
 && apk del --no-cache --purge .build-dependencies \
 && rm -rf \
        /tmp/.[!.]* \
        /tmp/* \
        /usr/local/share/.cache

RUN mkdir -p /share/json2mqtt \
 && addgroup --system --gid 1234 json2mqtt \
 && adduser --system -u 1234 --home /share/json2mqtt --shell /sbin/nologin --ingroup json2mqtt  json2mqtt

COPY rootfs /
WORKDIR /etc/json2mqtt

ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

LABEL \
    io.hass.name="Json to MQTT" \
    io.hass.description="Send data from json apis to MQTT" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.title="Json to MQTT" \
    org.opencontainers.image.description="Send data from json apis to MQTT" \
    org.opencontainers.image.vendor="https://github.com/flapperdeflipper/json2mqtt" \
    org.opencontainers.image.authors="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/flapperdeflipper/addons" \
    org.opencontainers.image.source="https://pypi.org/project/json2mqtt" \
    org.opencontainers.image.documentation="https://github.com/flapperdeflipper/addons/blob/master/json2mqtt/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

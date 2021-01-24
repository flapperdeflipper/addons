ARG BUILD_FROM
FROM $BUILD_FROM

ARG UNIFI2MQTT_VERSION="1.1.0"

ENV LANG C.UTF-8
ENV UNIFI2MQTT_RUNNING_IN_CONTAINER=true

SHELL ["/bin/bash", "-o", "pipefail", "-c", "+x"]

RUN apk add --no-cache --virtual .build-dependencies \
      npm \
 \
 && apk add --no-cache \
      curl \
      jq \
      nodejs \
 \
 && apk add runuser --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main \
 && npm config set unsafe-perm \
 && npm install -g pm2 unifi2mqtt@${UNIFI2MQTT_VERSION} \
 && apk del --no-cache --purge .build-dependencies \
 && rm -rf \
        /root/.node-gyp \
        /root/.npm \
        /tmp/.[!.]* \
        /tmp/* \
        /usr/local/share/.cache

RUN mkdir -p /usr/share/unifi2mqtt \
 && addgroup --system --gid 6329 unifi2mqtt \
 && adduser --system -u 6329 --home /usr/share/unifi2mqtt --shell /sbin/nologin --ingroup unifi2mqtt  unifi2mqtt

COPY rootfs /
WORKDIR /etc/unifi2mqtt

ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

LABEL \
    io.hass.name="Unifi to MQTT" \
    io.hass.description="Connecting your unifi speakers to mqtt" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.title="Unifi to MQTT" \
    org.opencontainers.image.description="Connecting your unifi speakers to mqtt" \
    org.opencontainers.image.vendor="https://github.com/fliphess/addon-unifi2mqtt" \
    org.opencontainers.image.authors="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/fliphess/addon-unifi2mqtt" \
    org.opencontainers.image.source="https://www.npmjs.com/package/unifi2mqtt" \
    org.opencontainers.image.documentation="https://github.com/fliphess/home-assistant-addons/blob/master/unifi2mqtt/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

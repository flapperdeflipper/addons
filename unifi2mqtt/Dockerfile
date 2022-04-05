ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

RUN apk add --no-cache \
      curl \
      jq \
 \
 && apk add runuser --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main \
 && rm -rf \
        /tmp/.[!.]* \
        /tmp/*

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
    org.opencontainers.image.description="Connecting your unifi controller to mqtt" \
    org.opencontainers.image.vendor="https://github.com/flapperdeflipper/addon-unifi2mqtt" \
    org.opencontainers.image.authors="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/flapperdeflipper/addon-unifi2mqtt" \
    org.opencontainers.image.source="https://github.com/mannkind/unifi2mqtt" \
    org.opencontainers.image.documentation="https://github.com/flapperdeflipper/home-assistant-addons/blob/master/unifi2mqtt/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

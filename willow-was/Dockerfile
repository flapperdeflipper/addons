ARG BUILD_FROM
ARG WAS_VERSION
FROM $BUILD_FROM:$WAS_VERSION

COPY rootfs /
WORKDIR /app

ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

LABEL \
    io.hass.name="Willow WAS" \
    io.hass.description="Run a willow application service" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    org.opencontainers.image.title="Willow WAS" \
    org.opencontainers.image.description="Run a willow application service" \
    org.opencontainers.image.vendor="https://github.com/toverainc/willow-application-server" \
    org.opencontainers.image.documentation="https://github.com/flapperdeflipper/addons/blob/master/willow-was/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

CMD [ "/init.sh" ]

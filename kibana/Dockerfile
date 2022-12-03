ARG BUILD_FROM
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

FROM ${BUILD_FROM}

LABEL \
    io.hass.name="Kibana" \
    io.hass.description="Kibana hass addon" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.title="Kibana" \
    org.opencontainers.image.description="Kibana hass addon" \
    org.opencontainers.image.vendor="Flipkes Home Assistant Add-ons" \
    org.opencontainers.image.authors="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://addons.fliphess.com" \
    org.opencontainers.image.source="https://github.com/flapperdeflipper/home-assistant-addons" \
    org.opencontainers.image.documentation="https://github.com/flapperdeflipper/home-assistant-addons/blob/master/kibana/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

EXPOSE 5601


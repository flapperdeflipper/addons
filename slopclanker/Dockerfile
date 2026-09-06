#############
# Thin wrapper: the application lives in flapperdeflipper/slopclanker and
# is released as ghcr.io/flapperdeflipper/slopclanker:<version>. This layer
# adds the Supervisor entrypoint; bump the FROM tag together with the
# config.yaml version (Dependabot opens the FROM bump for you).
ARG BUILD_ARCH
ARG BUILD_VERSION

FROM ghcr.io/flapperdeflipper/slopclanker:1.0.0

COPY run.sh /run.sh
RUN chmod a+x /run.sh

ENTRYPOINT ["/run.sh"]

LABEL \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION}

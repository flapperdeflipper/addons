# Mealie add-on: the official upstream image plus an options wrapper.
#
# FROM is hardcoded instead of BUILD_FROM/build.yaml: the Supervisor's
# build_from regex rejects multi-segment registry paths like
# ghcr.io/mealie-recipes/... (same approach as the litellm add-on).
#
# Pinned to an immutable release tag. Renovate bumps it; the post-upgrade task
# bumps config.yaml version and CHANGELOG.md alongside.
#
# The base is python:3.14-slim with bash, gosu and curl. Upstream's
# HEALTHCHECK (curl /api/app/about) and port 9000 are inherited.
FROM ghcr.io/mealie-recipes/mealie:v3.31.0

ARG BUILD_ARCH
ARG BUILD_VERSION

COPY rootfs/ /
RUN chmod 0755 /addon-run.sh

ENTRYPOINT ["/addon-run.sh"]

LABEL \
    io.hass.name="Mealie" \
    io.hass.description="Recipe manager and meal planner" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"

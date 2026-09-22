# https://developers.home-assistant.io/docs/add-ons/configuration#add-on-dockerfile
ARG BUILD_FROM=couchdb:3.5.2
FROM ${BUILD_FROM}

# The official couchdb image is Debian-based and carries no s6-overlay, so
# this add-on runs run.sh directly (init: false) rather than through an
# s6-overlay service tree.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        jq \
        openssl \
    && rm -rf /var/lib/apt/lists/*

COPY run.sh /run.sh
RUN chmod +x /run.sh

# io.hass.* labels are injected by home-assistant/builder.
ENTRYPOINT ["/run.sh"]

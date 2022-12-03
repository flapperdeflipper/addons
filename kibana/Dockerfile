ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV KBN_HOME=/usr/share/kibana \
    KBN_PATH_CONF=/etc/kibana \
    RESTART_ON_UPGRADE="true" \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
     apt-transport-https \
     ca-certificates \
     gpg \
     openssl \
     wget \
 && wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch \
    | gpg \
        --dearmor \
        -o /usr/share/keyrings/elasticsearch-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/elasticsearch-keyring.gpg] https://artifacts.elastic.co/packages/8.x/apt stable main" \
    | tee /etc/apt/sources.list.d/elastic-8.x.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends kibana \
 && apt-get clean \
 && rm -rf \
     /var/lib/apt/lists/* \
     /var/log/* \
     /tmp/*

COPY rootfs /

ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION
LABEL \
    io.hass.name="Moquitto" \
    io.hass.description="Kibana dashboard addon" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.title="Kibana" \
    org.opencontainers.image.description="Kibana dashboard addon" \
    org.opencontainers.image.vendor="Flipkes Home Assistant Add-ons" \
    org.opencontainers.image.authors="Flip Hess <flip@fliphess.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="flapperdeflipper/addon-kibana" \
    org.opencontainers.image.source="https://github.com/flapperdeflipper/home-assistant-addons" \
    org.opencontainers.image.documentation="https://github.com/flapperdeflipper/home-assistant-addons/blob/master/kibana/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

WORKDIR /usr/share/kibana
USER root
EXPOSE 5601

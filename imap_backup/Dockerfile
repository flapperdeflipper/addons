# https://developers.home-assistant.io/docs/add-ons/configuration#add-on-dockerfile
ARG BUILD_FROM=alpine:3.24.3
FROM ${BUILD_FROM}

# Plain Alpine with Dovecot, no s6-overlay: run.sh prepares accounts, storage
# and TLS, then execs dovecot in the foreground (Docker's init reaps).
# vmail owns every mailbox; fixed ids so files on /share keep their owner
# across image rebuilds and on the hb mirror (rsync --numeric-ids).
# hadolint ignore=DL3018
RUN apk add --no-cache \
        bash \
        dovecot \
        jq \
        openssl \
    && addgroup -S -g 5000 vmail \
    && adduser -S -D -H -u 5000 -G vmail -h /var/empty -s /sbin/nologin vmail

COPY rootfs /
RUN chmod +x /run.sh

# io.hass.* labels are injected by home-assistant/builder.
EXPOSE 993
ENTRYPOINT ["/run.sh"]

ARG BUILD_FROM
FROM $BUILD_FROM
ARG WIFIQR_VERSION="0.0.3"

ENV LANG C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c", "+x"]

RUN \
    apk add --update --no-cache --virtual .build-dependencies \
        gcc \
        libc-dev \
        libffi-dev \
        openssl-dev \
        python3-dev \
        py3-pip \
    \
    && apk add --no-cache \
        git \
        python3 \
        shadow \
        su-exec \
        tzdata \
        freetype-dev \
        fribidi-dev \
        harfbuzz-dev \
        jpeg-dev \
        lcms2-dev \
        openjpeg-dev \
        tcl-dev \
        tiff-dev \
        tk-dev \
        zlib-dev \
    \
    && apk add runuser --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main \
    && pip3 install \
        --no-cache-dir \
        --prefer-binary \
        --upgrade \
            flask-wifiqr=="${WIFIQR_VERSION}" \
            uwsgi \
    \
    && find /usr/local \
        \( -type d -a -name test -o -name tests -o -name '__pycache__' \) \
        -o \( -type f -a -name '*.pyc' -o -name '*.pyo' \) \
        -exec rm -rf '{}' + \
    \
    && apk del --no-cache --purge .build-dependencies

RUN mkdir -p /usr/share/wifiqr \
 && addgroup --system --gid 666 wifiqr \
 && adduser --system -u 666 --home /usr/share/wifiqr --shell /sbin/nologin --ingroup wifiqr  wifiqr

COPY rootfs /
WORKDIR /usr/share/wifiqr

ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

LABEL \
    io.hass.name="Wifiqr" \
    io.hass.description="Wifiqr is a small but powerful CalDAV (calendars, todo-lists) and CardDAV (contacts) server" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Flip Hess <flip@fliphess.com>" \
    org.label-schema.description="Wifiqr is a small python app that shows your wifi password as a QR code for mobile devices." \
    org.label-schema.build-date=${BUILD_DATE} \
    org.label-schema.name="Wifiqr" \
    org.label-schema.schema-version="1.0" \
    org.label-schema.url="" \
    org.label-schema.usage="" \
    org.label-schema.vcs-ref=${BUILD_REF} \
    org.label-schema.vcs-url="https://github.com/fliphess/addons" \
    org.label-schema.vendor="Flipjes addons"

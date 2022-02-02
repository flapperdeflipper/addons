ARG BUILD_FROM
FROM $BUILD_FROM
ARG SYNCTHING_VERSION

RUN apk add \
        --no-cache \
        --repository=http://dl-cdn.alpinelinux.org/alpine/edge/community \
        "syncthing=$SYNCTHING_VERSION"

ENTRYPOINT [ "/init" ]
CMD []
COPY root /

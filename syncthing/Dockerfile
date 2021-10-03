ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache --repository=http://dl-cdn.alpinelinux.org/alpine/edge/community \
		"syncthing=v1.18.2"

ENTRYPOINT [ "/init" ]
CMD []
COPY root /

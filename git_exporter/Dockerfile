ARG BUILD_FROM
FROM $BUILD_FROM AS RUNNING

RUN apk add --no-cache \
			'git' \
			'rsync' \
			'grep' \
			'sed' \
			'python3' \
			'py3-pip' \
			'findutils'

RUN pip3 install --no-cache-dir PyYAML dotty-dict

COPY root /
RUN chmod a+x /run.sh /utils/*
ENTRYPOINT [ "/run.sh" ]

ARG BUILD_FROM
FROM $BUILD_FROM

RUN pip3 install --no-cache-dir "paho-mqtt>=2.1,<3"

COPY rootfs/ /

WORKDIR /app
CMD ["python3", "/app/app.py"]

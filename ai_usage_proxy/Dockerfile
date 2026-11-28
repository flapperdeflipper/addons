# syntax=docker/dockerfile:1
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.15-alpine3.24
FROM $BUILD_FROM

RUN pip3 install --no-cache-dir "paho-mqtt>=2.1,<3"

COPY rootfs/ /
WORKDIR /app
CMD ["python3", "/app/app.py"]

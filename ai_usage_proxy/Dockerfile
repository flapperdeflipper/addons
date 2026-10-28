# syntax=docker/dockerfile:1
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.14-alpine3.21
FROM $BUILD_FROM

# Official @openai/codex Linux x64 package, pinned to 0.164.0 and its content hash.
# Extract only account-service executables; no voice or agent resource bundle is needed.
ADD --checksum=sha256:62659fefd9a8efa21a496402fde3c11c025bbeee735a582968f8ffd14cb5f79c https://registry.npmjs.org/@openai/codex/-/codex-0.164.0-linux-x64.tgz /tmp/codex.tgz
RUN tar -xzf /tmp/codex.tgz -C /usr/local/bin --strip-components=4 \
        package/vendor/x86_64-unknown-linux-musl/bin/codex \
        package/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host \
    && rm /tmp/codex.tgz \
    && codex --version \
    && pip3 install --no-cache-dir "paho-mqtt>=2.1,<3"

COPY rootfs/ /
WORKDIR /app
CMD ["python3", "/app/app.py"]

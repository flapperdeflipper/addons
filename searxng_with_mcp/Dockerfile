#############
ARG BUILD_ARCH
ARG BUILD_VERSION

# Pinned SearXNG base image — bump this tag to control the version
FROM searxng/searxng:2026.9.4-15b0c8ef3

COPY rootfs/ /
COPY mcp_server.py /
COPY secrets_engines.py /
COPY search_formats.py /
COPY requirements.txt .
RUN python -m ensurepip --upgrade
RUN pip3 install --no-cache-dir -r requirements.txt

RUN chmod a+x /run.sh

ENTRYPOINT ["/run.sh"]

LABEL \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION}
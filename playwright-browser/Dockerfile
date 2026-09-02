# Copied from robsonfelix/robsonfelix-hass-addons (playwright-browser 0.1.12, MIT),
# image bumped to the latest Playwright release.
# Update procedure: /homeassistant/opencode/PLAYWRIGHT-MCP.md
#
# NOTE: hardcoded instead of using BUILD_FROM/build.yaml because the HA
# Supervisor's build_from regex rejects single-segment image paths like
# "mcr.microsoft.com/playwright", silently falling back to the Alpine base.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

LABEL maintainer="Robson Felix"
LABEL io.hass.version="1.62.1"
LABEL io.hass.type="addon"
LABEL io.hass.arch="amd64,aarch64"
LABEL org.opencontainers.image.title="Playwright Browser for Home Assistant"
LABEL org.opencontainers.image.description="Headless Chromium with CDP endpoint for browser automation"
LABEL org.opencontainers.image.source="https://github.com/robsonfelix/robsonfelix-hass-addons"
LABEL org.opencontainers.image.licenses="MIT"

RUN apt-get update && \
    apt-get install -y --no-install-recommends jq curl nginx && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 9222

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:9222/json/version || exit 1

CMD ["/run.sh"]

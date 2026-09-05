# Copied from robsonfelix/robsonfelix-hass-addons (playwright-browser 0.1.12, MIT),
# image bumped to the latest Playwright release.
# Update procedure: /homeassistant/opencode/PLAYWRIGHT-MCP.md
#
# NOTE: FROM is hardcoded instead of using BUILD_FROM/build.yaml because both
# the HA Supervisor's build_from regex and the single-segment image path
# convention reject images like "mcr.microsoft.com/playwright". CI builds this
# with a plain docker build, so no build.yaml is needed.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

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

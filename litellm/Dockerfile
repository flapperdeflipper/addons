# LiteLLM proxy add-on: OpenAI-compatible LLM gateway for the Assist pipeline.
#
# NOTE: FROM is hardcoded instead of using BUILD_FROM/build.yaml because the
# HA Supervisor's build_from regex and the single-segment image path
# convention reject multi-segment registry images like "ghcr.io/berriai/..."
# (same approach as playwright-browser in this repo).
#
# Pinned to an immutable semver tag: LiteLLM's rolling "main-stable" tag is
# deprecated (no longer published since 2026-09-01). Bump this tag together
# with `version:` in config.yaml.
#
# Base image is Alpine with bash and python3.13 preinstalled. npm/npx are
# added for stdio MCP servers (e.g. @playwright/mcp); run.sh parses
# /data/options.json with python3 and the health check uses python's urllib.
FROM ghcr.io/berriai/litellm-database:v1.99.1

RUN apk add --no-cache npm

COPY run.sh /run.sh
COPY mcp_servers/litellm_mcp /mcp_servers/litellm_mcp

# Full Home Assistant MCP server (ha-mcp-server) from the published
# ha_opencode add-on image. Dependencies are pure JS (MCP SDK, ws, yaml,
# zod, puppeteer-core) so the Debian-built node_modules run fine on this
# Alpine base. Companion CLIs (zigporter, hab) are NOT present here: their
# tools appear in the catalog but fail at call time - serving them properly
# needs the HTTP-transport route in ha_opencode instead of this copy.
# Pin to the released ha_opencode version; bump together with `version:`.
COPY --from=flapperdeflipper/addon-ha-opencode:2.7.0 /opt/ha-mcp-server /mcp_servers/ha-mcp-server

RUN chmod +x /run.sh

EXPOSE 4000 4001

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python3 -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness', timeout=5).status == 200 else 1)"

ENTRYPOINT ["/run.sh"]

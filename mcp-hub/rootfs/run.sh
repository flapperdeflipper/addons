#!/bin/bash
# ==============================================================================
# MCP Hub entrypoint. Deliberately minimal: no bashio, no s6 - the Supervisor
# resolves !secret values into /data/options.json before start, and the
# gateway reads that file directly. Every option can be overridden through
# HUB_* environment variables (used by the tests).
# ==============================================================================
set -euo pipefail

export NODE_ENV=production

exec node /opt/mcp-hub/src/gateway.js

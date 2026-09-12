"""Environment-derived configuration for litellm-mcp."""

import os

HOST_ENV = "LITELLM_MCP_HOST"
PORT_ENV = "LITELLM_MCP_PORT"
BASE_URL_ENV = "LITELLM_INTERNAL_URL"
KEY_ENV = "LITELLM_MEMORY_KEY"
MASTER_KEY_ENV = "LITELLM_MASTER_KEY"
AUTH_TOKEN_ENV = "LITELLM_MCP_AUTH_TOKEN"

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 4001
DEFAULT_BASE_URL = "http://127.0.0.1:4000"


def host():
    return os.environ.get(HOST_ENV, DEFAULT_HOST)


def port():
    try:
        return int(os.environ.get(PORT_ENV, str(DEFAULT_PORT)))
    except ValueError:
        return DEFAULT_PORT


def base_url():
    return os.environ.get(BASE_URL_ENV, DEFAULT_BASE_URL).rstrip("/")


def api_key():
    """Preferred scoped key, falling back to the master key run.sh exports."""
    return os.environ.get(KEY_ENV) or os.environ.get(MASTER_KEY_ENV, "")


def auth_token():
    """Client-facing bearer token for standalone streamable-http serving.

    Defaults to the upstream API key (whoever holds it can hit the proxy
    directly anyway, so no new secret is introduced). An explicit empty
    value cannot disable auth via the environment: unset means "derive",
    anything else is the token.
    """
    return os.environ.get(AUTH_TOKEN_ENV, "").strip() or api_key()

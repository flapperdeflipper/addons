"""litellm-mcp: MCP tools for the LiteLLM proxy, served from the LiteLLM add-on.

A cohesive package with a proper entry point:

    PYTHONPATH=/mcp_servers python -m litellm_mcp memory --host 0.0.0.0 --port 4001

Tool modules live in ``litellm_mcp/tools`` and declare ``NAME``,
``DESCRIPTION`` and ``register(server, client)``; enabling is by CLI argument
(validated against the registry), and secrets arrive via environment - never
command line.
"""

__version__ = "1.0.0"

"""Command line entry point for litellm-mcp."""

import argparse
import sys

from . import __version__, config
from .litellm_client import compact


def registry():
    from .tools import REGISTRY

    return REGISTRY


def build_parser():
    parser = argparse.ArgumentParser(
        prog="litellm-mcp",
        description="Serve LiteLLM proxy MCP tools over streamable HTTP. "
        "Enabled tools are positional arguments; the API key comes from the "
        "environment (LITELLM_MEMORY_KEY or LITELLM_MASTER_KEY), never the "
        "command line.",
    )
    parser.add_argument(
        "tools",
        nargs="*",
        choices=sorted(registry()),
        metavar="TOOL",
        help="tool module(s) to enable: %s" % ", ".join(sorted(registry())),
    )
    parser.add_argument("--list", action="store_true", help="print the tool catalog and exit (no SDK needed)")
    parser.add_argument(
        "--transport",
        choices=("streamable-http", "stdio"),
        default="streamable-http",
        help="serve over streamable HTTP (standalone) or stdio (spawned by the LiteLLM MCP gateway)",
    )
    parser.add_argument("--host", default=config.host(), help="bind address (env %s, default %%(default)s)" % config.HOST_ENV)
    parser.add_argument("--port", type=int, default=config.port(), help="bind port (env %s, default %%(default)s)" % config.PORT_ENV)
    parser.add_argument("--base-url", default=config.base_url(), help="proxy base URL (env %s, default %%(default)s)" % config.BASE_URL_ENV)
    return parser


def print_catalog():
    print("litellm-mcp %s - available tool modules:" % __version__)
    for name, mod in sorted(registry().items()):
        print("  %-16s %s" % (name, mod.DESCRIPTION))


def register_builtin(server, enabled):
    """Register the always-on discovery tool (independent of tool modules)."""

    @server.tool()
    def registry_list() -> str:
        """Discover every MCP tool module this litellm-mcp deployment offers.

        Returns each module's name, description and whether it is enabled on
        this server. Disabled modules can be enabled via the LiteLLM add-on
        options (requires an add-on restart).
        """
        return compact({
            "server": "litellm-mcp",
            "version": __version__,
            "modules": [
                {"name": name, "description": mod.DESCRIPTION, "enabled": name in enabled}
                for name, mod in sorted(registry().items())
            ],
        })


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.list:
        print_catalog()
        return
    if not args.tools:
        parser.error("at least one TOOL is required (or use --list)")

    api_key = config.api_key()
    if not api_key:
        print("WARNING: no API key in environment; tools will fail until one is set", file=sys.stderr)

    from .litellm_client import LitellmClient
    from .mcp_compat import ServerRunner

    runner = ServerRunner("litellm-mcp", args.host, args.port)
    client = LitellmClient(args.base_url, api_key)
    for name in args.tools:
        registry()[name].register(runner.server, client)
    register_builtin(runner.server, set(args.tools))

    if args.transport == "stdio":
        print("litellm-mcp serving over stdio - tools: %s" % ", ".join(args.tools), file=sys.stderr)
    else:
        print(
            "litellm-mcp serving on %s:%s/mcp - tools: %s" % (args.host, args.port, ", ".join(args.tools)),
            file=sys.stderr,
        )
    runner.run(args.transport)

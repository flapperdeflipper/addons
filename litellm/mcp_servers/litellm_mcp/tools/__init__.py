"""Tool modules available to the MCP server.

Each module declares NAME, DESCRIPTION and register(server, client) where
client is a configured LitellmClient. Adding a tool: create the module, add
one line to REGISTRY, and translate its add-on option to a CLI argument in
run.sh. Unknown tool names are impossible by construction (argparse
validates against this registry).
"""

from . import memory

REGISTRY = {
    memory.NAME: memory,
}

# HA MCP

The Home Assistant MCP server (ha-mcp-server, from the OpenCode add-on) on
its own, over streamable HTTP on port 8927 with a bearer token, for agents
that run somewhere else: an MCP gateway, a coding agent on another machine.

It runs inside Home Assistant because its tools need what only an add-on
has: the Supervisor API (apps, backups, updates, logs), the hab and zigporter
CLIs, and the configuration directory.

## Tool profile: deployed

Every tool except the ones that write configuration files: Home Assistant's
YAML (`write_config_safe`) and ESPHome's device YAML (create, update,
migrate, companion files, restore from history, clone or rename, metadata,
API keys). The idea: the configuration lives in git and a merge deploys it,
so changes go through pull requests. Everything that acts at runtime stays:
service calls, events, to-do lists, MQTT, dashboards through hab, updates,
ESPHome compile, upload and flashing, logs and diagnostics. The
configuration directory is mapped read-only.

A refused tool answers with a message that points at the repository.

## Configuration

| Option | Meaning |
|---|---|
| `mcp_http_token` | Bearer token clients send. Required; `!secret <key>` works. |
| `access_token` | Long-lived access token, for screenshots and the ESPHome Device Builder. |
| `z2m_url`, `z2m_mqtt_topic` | Zigbee2MQTT for zigporter; empty address: discover the add-on. |

Clients connect to `http://<home-assistant>:8927/mcp`. Only expose the port
on a trusted network: the token is the only lock, and traffic is plain HTTP.

# OpenChamber

Browser UI for OpenCode conversations, running as its own Home Assistant app.
It attaches to the [OpenCode add-on](https://github.com/flapperdeflipper/addons)
and shows exactly the sessions that add-on owns — OpenChamber never spawns an
OpenCode process and stores no sessions of its own.

## How it works

- OpenChamber runs in external-server mode: it connects to the OpenCode
  add-on's LAN server over HTTP and authenticates with shared basic-auth
  credentials on every API call.
- Two first-party proxies front the OpenChamber server (loopback `3010`):
  - **Ingress** (`8099`): strict remote allowlist (loopback + Supervisor
    ingress proxy only). Authentication is Home Assistant's own login. This is
    the recommended path.
  - **LAN** (`4097/tcp`, mappable): accepts any remote address but enforces
    HTTP Basic auth at the proxy — including WebSocket upgrades — with the
    same credentials OpenChamber uses towards the OpenCode server.
- OpenChamber is pinned (`@openchamber/web` 1.24.1) and Ingress-patched at
  image build time. Its built-in self-update is disabled and reports no update;
  update OpenChamber by updating this add-on.

## Requirements

This add-on depends on the **OpenCode add-on** (ha_opencode 3.0.0+):

1. In the OpenCode add-on's Configuration tab, set its **LAN server password**
   (`!secret <key>` values work). The LAN server itself is always on.
2. In its Network settings, map `4096/tcp` to a host port.
3. In OpenChamber's Configuration tab, set **OpenCode server port** to that
   host port and the same password. The username is always `opencode`.

The Supervisor has no generic app-to-app dependency mechanism, so this
dependency is enforced behaviourally: OpenChamber waits up to two minutes for
the OpenCode server at startup, logs why it is waiting, and keeps retrying
afterwards (the UI shows a "waiting for server" state until OpenCode answers).

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| **OpenCode server address** | *(auto)* | Origin of the OpenCode LAN server, scheme included, no port (e.g. `http://192.168.1.50`). Empty auto-discovers the Docker host gateway. |
| **OpenCode server port** | `4096` | Host port that the OpenCode add-on's `4096/tcp` is mapped to. |
| **OpenCode server password** | — | Basic-auth password shared with the OpenCode add-on (username is always `opencode`). Required; `!secret <key>` works. |
| **LAN trusted remotes** | *(empty)* | IP addresses or CIDRs the reverse proxy connects from. Only these and loopback are proxied on `4097/tcp`. |
| **LAN redirect URL** | *(empty)* | Where untrusted sources are sent (e.g. `https://openchamber.pl4.dev` behind your OAuth proxy). Empty = plain 403. |

## Network

| Port | Purpose |
|------|---------|
| `4097/tcp` | OpenChamber web UI at `/` for the **trusted reverse proxy only** — every other source is redirected to **LAN redirect URL**. Leave unmapped for Ingress-only use. |

The intended pattern is an authenticating reverse proxy (nginx with an OAuth
proxy, Cloudflare Access, ...) on the public hostname, forwarding to this
port. Only loopback and the addresses in **LAN trusted remotes** are proxied;
anything else — including anyone guessing the raw `host:port` — is sent to the
public URL, where the proxy makes them log in.

Example nginx location for a public hostname:

```nginx
location / {
    # Ride the docker-proxy path from the same host: use loopback, and the
    # connection arrives as a trusted source.
    proxy_pass http://127.0.0.1:<mapped-4097-port>;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

### Discovering the proxy's source address

If the reverse proxy does not connect from loopback, its requests are rejected
and logged. Watch the add-on log while sending one request through the proxy:

```text
Rejected 10.20.0.9: not in trusted remotes — redirecting to https://openchamber.pl4.dev. [...]
```

Add the logged address (or its CIDR) to **LAN trusted remotes** and restart.
An empty list means loopback-only: nothing off-box is proxied.

## Security model

- **Ingress path**: Home Assistant login only, same as every Ingress app.
  The ingress proxy refuses any client that is not the Supervisor's ingress
  proxy or loopback.
- **Mapped `4097/tcp`**: loopback + trusted-remotes allowlist enforced by the
  proxy; untrusted sources are redirected to the public URL (or refused with
  403 when no redirect URL is set) and logged. Authentication itself is
  delegated to whatever fronts the public URL (OAuth proxy, Cloudflare
  Access, ...) — nothing is proxied unless the connection comes from a
  trusted address.
- The add-on holds no Supervisor or Home Assistant API access — its only
  network privilege is the outbound connection to the OpenCode server. It
  mounts the same directories as the OpenCode add-on (`/homeassistant`,
  `/local_apps`, `/addon_configs`, `/share`, read-write) so workspace paths
  behave identically in both containers.

## Agent MCP server (project notes, todos, plans)

Opt-in (`mcp_enabled` + `mcp_token`): serves
OpenChamber's **Project Notes** — the notes, todos and plans of the web UI —
to agent clients over the Model Context Protocol on `4100`/tcp, reachable
from other add-ons on the internal network (e.g.
`http://<this-add-on>:4100/mcp`). Never host-mapped; every request must carry
`Authorization: Bearer <token>`.

- **One store by construction**: every tool call proxies the loopback-only
  REST API (`127.0.0.1:3010/api/project-context/:projectId`). The JSON files
  under `/data/.config/openchamber/projects/` stay owned by the OpenChamber
  server alone, so the web UI and agent sessions can never drift apart.
- **Tools**: `openchamber_context`, `openchamber_note_add` (tagged
  `source: agent`), `openchamber_note_edit`, `openchamber_note_delete`,
  `openchamber_todo_add`, `openchamber_todo_toggle`,
  `openchamber_todo_delete`, `openchamber_plan_read`. Projects are addressed
  by directory (`/homeassistant` by default) and mapped with OpenChamber's
  own `path_<base64url>` id rule.
- **Transport**: the same stateless streamable-HTTP shape as the OpenCode
  add-on's ha-mcp-server HTTP mode (`GET /health`, `POST /mcp`).
- **Token**: `mcp_token` holds either a literal token or a `!secret <key>`
  reference, resolved from `/homeassistant/secrets.yaml` at every start
  (quotes around the value are stripped). The option never stores the
  resolved secret; only the key name is logged.

## Troubleshooting

- **"Waiting for server"** in the UI: the OpenCode server is not reachable.
  Check the OpenCode add-on is running, the port mapping matches
  **OpenCode server port**, and the password matches its **LAN server
  password**.
- **Redirected to the public URL from the raw port**: expected — the source
  is not in **LAN trusted remotes**. Check the add-on log for the `Rejected
  <address>` line and add it.
- Logs: the add-on log states the discovered OpenCode origin and whether the
  server answered during the startup wait.

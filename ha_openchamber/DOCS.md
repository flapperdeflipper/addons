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
- OpenChamber is pinned (`@openchamber/web` 1.21.0) and Ingress-patched at
  image build time. Its built-in self-update is disabled and reports no update;
  update OpenChamber by updating this add-on.

## Requirements

This add-on depends on the **OpenCode add-on** (ha_opencode 2.13.0+):

1. In the OpenCode add-on's Configuration tab, turn on **OpenCode LAN server**
   and set its **LAN server username/password** options
   (`!secret <key>` values work).
2. In its Network settings, map `4096/tcp` to a host port.
3. In OpenChamber's Configuration tab, set **OpenCode server port** to that
   host port and the same username/password.

The Supervisor has no generic app-to-app dependency mechanism, so this
dependency is enforced behaviourally: OpenChamber waits up to two minutes for
the OpenCode server at startup, logs why it is waiting, and keeps retrying
afterwards (the UI shows a "waiting for server" state until OpenCode answers).

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| **OpenCode server address** | *(auto)* | Origin of the OpenCode LAN server, scheme included, no port (e.g. `http://192.168.1.50`). Empty auto-discovers the Docker host gateway. |
| **OpenCode server port** | `4096` | Host port that the OpenCode add-on's `4096/tcp` is mapped to. |
| **OpenCode server username** | *(empty)* | Basic-auth username; empty means `opencode`, the OpenCode server's default. |
| **OpenCode server password** | — | Basic-auth password shared with the OpenCode add-on. Required; `!secret <key>` works. Also protects the mapped `4097/tcp` UI port. |

## Network

| Port | Purpose |
|------|---------|
| `4097/tcp` | OpenChamber web UI at `/` with basic auth — point a reverse proxy or tunnel straight at it. Leave unmapped for Ingress-only use. |

Example nginx location for a public hostname:

```nginx
location / {
    proxy_pass http://<home-assistant-host>:4097;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## Security model

- **Ingress path**: Home Assistant login only, same as every Ingress app.
  The ingress proxy refuses any client that is not the Supervisor's ingress
  proxy or loopback.
- **Mapped `4097/tcp`**: HTTP Basic auth enforced by the proxy (constant-time
  credential comparison). Use unique credentials for this purpose — they travel
  as base64 on every request, so serve the port over TLS (e.g. through your
  reverse proxy) whenever it leaves a trusted network.
- The add-on holds no Supervisor or Home Assistant API access and mounts no
  configuration directories; its only privilege is the outbound connection to
  the OpenCode server.

## Troubleshooting

- **"Waiting for server"** in the UI: the OpenCode server is not reachable.
  Check the OpenCode add-on is running, its LAN server is enabled, the port
  mapping matches **OpenCode server port**, and the credentials match its
  **LAN server username/password**.
- **401 in the browser**: wrong basic-auth credentials on the mapped port —
  the same password as the OpenCode add-on's **LAN server password**.
- Logs: the add-on log states the discovered OpenCode origin and whether the
  server answered during the startup wait.

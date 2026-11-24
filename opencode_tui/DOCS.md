# OpenCode TUI

OpenCode's terminal interface in a Home Assistant panel, attached to an
OpenCode server elsewhere on your network (`opencode serve`). The sessions,
their models, tools and files all live on that server; this add-on only
draws the interface, so it needs no access to Home Assistant itself.

## Configuration

| Option | Meaning |
|---|---|
| `server_url` | The OpenCode server, e.g. `https://opencode.example.org`. Required. |
| `server_password` | The server's basic-auth password (user `opencode`). Required; `!secret <key>` works. |
| `directory` | Where sessions start, as a path **on the server**. Default `/workspace`. The add-on creates the same path locally as an empty placeholder: the client changes into it before it hands the path to the server. |
| `font_size` | Terminal font size. |

The client and the server should run the same OpenCode version: this
add-on's OpenCode comes from its base image (agent-base); bump the server
together with it.

## How it behaves

- The client runs inside tmux: closing the panel or opening it in a second
  browser keeps the session. Both browsers see the same terminal.
- When the client exits (you quit it, the server restarts, the network
  drops), the panel shows why and attaches again on a key press.
- Only basic auth reaches the server. A reverse proxy that asks for its own
  sign-in in front of the server blocks this client: let the proxy pass
  requests that carry the server's basic auth, or point `server_url` at an
  address without that sign-in.

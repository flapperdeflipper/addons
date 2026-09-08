# Claude Usage Proxy

One OAuth token lineage for Claude usage monitoring. The ESPHome displays
(`claude-*` devices) subscribe to MQTT topics; this add-on is the only thing
that talks to Anthropic. Token renewal happens once, in a browser.

## How it works

- Background loop: refreshes the access token before expiry (rotating and
  persisting the refresh token in `/data/tokens.json`), polls
  `api.anthropic.com/api/oauth/usage` every `poll_interval` seconds and
  publishes the figures as retained MQTT messages.
- Web page (Ingress, sidebar "Claude Usage Proxy"): live status and the
  renewal flow — open the Claude authorization link, approve, paste the
  `code#state` back. Done for every display.
- Broker credentials come from the Supervisor MQTT service (`/services/mqtt`,
  provided by the mosquitto add-on); the manual `mqtt_*` options are only a
  fallback.

## Topics

| Topic | Payload |
|---|---|
| `claude/usage/session_percent` | float, e.g. `42.5` |
| `claude/usage/week_percent` | float |
| `claude/usage/session_resets_at` | epoch seconds |
| `claude/usage/week_resets_at` | epoch seconds |
| `claude/usage/last_update` | epoch seconds of last successful poll |
| `claude/usage/status` | `ok`, `token rejected (http 400) - renew via web UI`, ... (LWT: `proxy offline`) |
| `claude/usage/command/refresh` | any payload = poll immediately |

## Options

| Key | Default | Description |
|---|---|---|
| `poll_interval` | `60` | Seconds between usage polls (10–3600). |
| `topic_prefix` | `claude/usage` | MQTT topic prefix. |
| `discovery` | `true` | Publish Home Assistant MQTT discovery sensors. |
| `mqtt_host` / `mqtt_port` / `mqtt_username` / `mqtt_password` | empty | Manual broker fallback when Supervisor service discovery is unavailable. |

With `discovery: true` the sensors appear in Home Assistant as
`Claude Session Usage`, `Claude Weekly Usage`, reset timestamps, and a
diagnostic status sensor — ready for dashboards.

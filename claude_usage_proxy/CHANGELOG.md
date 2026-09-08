# Changelog

## 1.0.1

- **Fix**: option schema must not use spaces inside `int(min,max)` - the Supervisor rejected the add-on's config with `int(1, 65535)?`.

## 1.0.0

- **Initial release.** Central Claude usage poller replacing the per-device OAuth flow of the ESPHome `claude_usage` component.
- **Single-page browser renewal** via Ingress using the Claude Code authorization-code + PKCE flow; one renewal covers all displays.
- **Central token loop**: refreshes and rotates access/refresh tokens before expiry, persisted in `/data/tokens.json`.
- **MQTT metrics**: retained session/week percentages, reset epochs, status and last-update under `claude/usage/*`, with optional Home Assistant discovery sensors.
- **Force-refresh command topic** `claude/usage/command/refresh` so device buttons can trigger an immediate poll.

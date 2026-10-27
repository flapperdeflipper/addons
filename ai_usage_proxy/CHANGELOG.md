# Changelog

## 2.1.2

- **Fixed:** the process status sensor showed `starting` for the whole uptime - it now publishes `ok` once connect-time bootstrap (discovery + view republication) finishes; `proxy offline` via the last will is unchanged
- **Fixed:** doubled entity name `AI Usage Proxy AI Usage Proxy Status` - the discovery name is now plain `Status`, which the device-name prefix completes to `AI Usage Proxy Status`

## 2.1.1

- **Add:** per-provider diagnostic sensors - `<provider> Status` (`ai/usage/<provider>/status`), `<provider> Last Update` (timestamp, null-safe template), and a `<provider> Online` connectivity binary sensor (`ai/usage/<provider>/availability`) - so every published topic has a Home Assistant entity

## 2.1.0

- **Breaking:** the process last will and status moved from the legacy `claude/usage/status` to `ai/usage/status` (the shared `ai_topic_prefix` root)
- **Breaking:** removed the `topic_prefix` option and the `claude/usage/*` compatibility topics; Claude publishes only `ai/usage/claude/*` like every other provider
- **Breaking:** Claude session/weekly sensors now use the `ai_usage_proxy_*` identity (window-based, like OpenAI/z.ai) instead of the preserved `claude_usage_proxy_*` entities; stale legacy topics and discovery messages are cleared from the broker automatically from the publish inventory
- **Add:** `AI Usage Proxy Status` diagnostic sensor on `ai/usage/status`, replacing `Claude Proxy Status`

## 2.0.1

- **Fixed:** reset-time sensors raised a Home Assistant template error (`int got invalid input 'None'`) on every publish while a provider reports `resets_at: null` (z.ai does until a reset time is known); discovery value templates now render the string `None` so the sensor reads as unknown without logging, instead of relying on availability alone - HA renders `value_template` for every state payload even when the entity is offline.

## 2.0.0

- Rename Claude Usage Proxy to AI Usage Proxy, with one modular application for Claude, OpenAI/Codex, and z.ai connections.
- Add a responsive Ingress dashboard with provider cards, usage bars, reset times, and separate connection panels. Every percentage means **used**.
- Preserve Claude OAuth renewal, legacy MQTT topics, and Home Assistant discovery identities; migrate existing private token files.
- Add managed OpenAI device login and subscription quota polling through a checksum-pinned Codex account service.
- Add z.ai Coding Plan key validation and confirmed legacy quota mappings; report unverified current credit formats explicitly as unsupported.
- Isolate provider polling, credential actions, errors, backoff, and stale readings. Add provider-specific MQTT topics, retained cleanup, and availability.
- Add regression, HTTP, subprocess, and optional browser tests.
- Log INFO and below to stdout and only warnings and errors to stderr, so Docker's journald driver no longer files routine messages at error priority.
- The slug changes to `ai_usage_proxy`; follow the README migration steps for an existing installation.

## 1.0.6

- **Fixed:** refuse to start (or degrade loudly) when an option is still a literal `!secret …` reference — a secrets.yaml key was missing at container start; a reference string must never be used as a credential
- enforced in the options parser for every string option

## 1.0.5

- **Fix**: find the Supervisor token under both `SUPERVISOR_TOKEN` and the legacy `HASSIO_TOKEN` name, in the environment or in s6's `/run/s6/container_environment/` - the base image's s6-overlay runs CMD without the Docker env, which silently broke MQTT service discovery.

## 1.0.4

- **Fix**: Ingress URLs - the renewal form posted to an absolute path that escaped the Ingress prefix (both `/api/hassio_ingress/...` and `/app/...`) and 404'd; internal links now honour `X-Ingress-Path`.
- **Diagnostics**: MQTT service discovery failures were silent; the add-on now reports whether `SUPERVISOR_TOKEN` exists and what `/services/mqtt` answers (throttled to once per 30s).
- **Add**: store icon + logo (Claude asterisk).

## 1.0.3

- **Fix**: renewal exchange rejected with "Invalid request format" - the Claude token endpoint requires the OAuth `state` to equal the PKCE code verifier (as the CLI does), not an independent random state.

## 1.0.2

- **Fix**: image namespace is `flapperdeflipper/addon-claude-usage-proxy` (CI publishes under the GitHub org, not `fliphess/`).

## 1.0.1

- **Fix**: option schema must not use spaces inside `int(min,max)` - the Supervisor rejected the add-on's config with `int(1, 65535)?`.

## 1.0.0

- **Initial release.** Central Claude usage poller replacing the per-device OAuth flow of the ESPHome `claude_usage` component.
- **Single-page browser renewal** via Ingress using the Claude Code authorization-code + PKCE flow; one renewal covers all displays.
- **Central token loop**: refreshes and rotates access/refresh tokens before expiry, persisted in `/data/tokens.json`.
- **MQTT metrics**: retained session/week percentages, reset epochs, status and last-update under `claude/usage/*`, with optional Home Assistant discovery sensors.
- **Force-refresh command topic** `claude/usage/command/refresh` so device buttons can trigger an immediate poll.

# AI Usage Proxy

One Home Assistant add-on connects your AI subscriptions and publishes their usage to MQTT. The Ingress dashboard has separate Claude, OpenAI / Codex, and z.ai cards with usage bars, reset times, connection controls, and last-update status. Monitoring runs on the Home Assistant host with the browser closed.

**Every percentage means used.** A provider response of 78% remaining becomes 22% used, both on the page and over MQTT. Unknown values stay unavailable; quota limits and expired authorization are treated separately.

## Connect your accounts

Open **AI Usage Proxy** in the Home Assistant sidebar. The MQTT badge shows publishing health independently of the provider connections.

- **Claude:** click Connect, open the authorization link, approve access, then paste the full `code#state` into the card. The proxy refreshes and persists rotating tokens automatically. Reconnect is needed only when authorization can no longer be renewed.
- **OpenAI / Codex:** click Connect, open the verification page, and enter the displayed device code. The card updates after approval. Device login may need enabling in your ChatGPT security settings or workspace permissions. The bundled Codex account service manages its own credentials. This monitors Codex subscription quotas, not every ChatGPT feature or OpenAI API billing. [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth).
- **z.ai:** click Connect and enter your **Personal Coding Plan API key**, then Save and test. A rejected replacement keeps the current key and readings. The confirmed legacy five-hour/MCP quotas are supported. New credit-based or ambiguous quota shapes show **Format unsupported**; weekly windows and reset times will appear only when their encoding has been verified. A key accepted by an explicit successful response can be saved even if its quota format is unsupported. [First-party quota implementation](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs).

**Manage connection** opens the account panel. Reconnect or Replace key changes only that provider. Disconnect proxy removes its local credentials/readings; it does not promise to revoke other sessions at the provider. Credentials are never returned in public status responses.

The page refreshes status without reloading open forms. Refresh usage requests an immediate reading while honoring upstream backoff. After three missed polling intervals, the last successful reading is marked stale. Network errors keep credentials; revoked credentials prompt reconnection and are rechecked every 10 minutes, so a provider recovers by itself after a temporary rejection. Other providers continue updating independently.

## MQTT topics

The default root is `ai/usage`; provider IDs are `claude`, `openai`, and `zai`. Messages are retained at QoS 1. The process status lives at the shared root:

| Topic | Payload |
| --- | --- |
| `ai/usage/status` | Process status: `starting` while booting, `proxy offline` via the retained last will when the process dies |

For example, per provider:

| Topic | Payload |
| --- | --- |
| `ai/usage/openai/state` | JSON containing status, availability, last update, aliases, and all windows |
| `ai/usage/openai/windows/codex_primary/used_percent` | Number, for example `22` |
| `ai/usage/openai/windows/codex_primary/resets_at` | UTC epoch seconds, when supplied |
| `ai/usage/openai/windows/codex_primary/duration_seconds` | Reported window length, when supplied |
| `ai/usage/openai/session_percent` | Percentage used for an identified short window |
| `ai/usage/openai/week_percent` | Percentage used for an identified weekly window |
| `ai/usage/openai/session_resets_at` | Reset epoch for that short window, when supplied |
| `ai/usage/openai/week_resets_at` | Reset epoch for that weekly window, when supplied |
| `ai/usage/openai/last_update` | Epoch of the last successful reading |
| `ai/usage/openai/status` | `starting`, `disconnected`, `ok`, `auth_required`, `rate_limited`, `error`, `unsupported`, or `stale` |
| `ai/usage/openai/availability` | `online` while a connected provider's sample is fresh; otherwise `offline` |
| `ai/usage/openai/command/refresh` | Publish any **non-retained** payload to request a reading |

Window IDs are stable per upstream bucket. The example `codex_primary` is not a guarantee that every account has that bucket. Additional buckets have their own window topics. Use the JSON state to discover the windows your account supplies; duration/reset may be `null`. Removed/unknown scalar values are cleared with retained empty payloads, never fake zero readings.

A display can subscribe to `ai/usage/openai/session_percent` and `week_percent`, plus `last_update` and availability, to render short/weekly gauges. If those aliases are unavailable, select an explicit window from `state`. In the dashboard, expand **MQTT topics** to copy common topics.

### Claude displays

Claude publishes the same provider topics as every other provider: `ai/usage/claude/session_percent`, `week_percent`, `*_resets_at`, `last_update`, `status`, and `command/refresh`. Claude session/weekly Home Assistant sensors use the `ai_usage_proxy_*` identity like all providers.

One MQTT connection has one last will: **`ai/usage/status = proxy offline`**, retained. Home Assistant entities combine that process will with per-provider availability. A custom display should also observe this will for immediate crash detection; the retained per-provider availability alone cannot detect a process crash.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `poll_interval` | `60` | Provider polling interval, 10–3600 seconds |
| `ai_topic_prefix` | `ai/usage` | Shared provider and process-status topic root |
| `discovery` | `true` | Publish Home Assistant MQTT discovery |
| `mqtt_host`, `mqtt_port`, `mqtt_username`, `mqtt_password` | empty / `1883` | Manual broker fallback |

Broker credentials normally come from the Supervisor MQTT service. Settings in the dashboard shows the current source and links to the add-on configuration; it does not keep a second settings or broker-password store. Provider credentials are managed in their cards.

The private `/data/providers/<provider>/` directories contain established credentials. Claude/z.ai files are written atomically with mode `0600`; Codex has its own private state directory. Pending browser/device logins end on restart; established connections resume. There is initially one account per provider.

## Migrate from Claude Usage Proxy

The repository contains the renamed add-on only. Its new slug is `ai_usage_proxy`; Home Assistant therefore treats its installed identity separately from `claude_usage_proxy` and does not perform a transparent installed-app rename.

1. Record the old add-on options, including any broker fallback. Keep the old installation/backup until the new one is working.
2. Stop the old Claude Usage Proxy.
3. Reload the add-on repository, install **AI Usage Proxy**, and copy the relevant options. Displays that subscribed to a legacy `claude/usage` prefix should move to `ai/usage/claude` (2.1.0 no longer publishes compatibility topics).
4. Start the new add-on and connect Claude through its dashboard. This is the supported migration path without access to private add-on files. Connect OpenAI and z.ai as needed.
5. Check the existing display readings and Home Assistant entities, then remove the old installation.

For a managed private-data transfer, an existing `/data/tokens.json` placed in the new add-on's private data is migrated automatically to the Claude credential store on startup. The original becomes `/data/tokens.json.migrated` with private permissions. The destination takes precedence, and disconnect does not reimport that backup. Do not run two instances sharing the same rotating token lineage. After rotation, a rollback using copied credentials needs the **latest** credential state rather than the original migration backup. Reauthorizing the old installation is the fallback.

## Development and adding a provider

Adapters live in `rootfs/app/providers/`. A provider implements the contract in `base.py`, supplies public authentication views, and returns immutable `UsageSnapshot`/`UsageWindow` values. Normalize remaining allowance with `percentage_used(value, remaining=True)`. Register the adapter in `PROVIDER_FACTORIES`; shared scheduling, cards, and publishing consume the normalized values.

The existing UI supports authorization-code, device-code, and API-key connections. A new authentication mechanism can add a panel type without changing the monitoring pipeline. Keep upstream payloads and secrets inside the adapter, and add verified/synthetic fixtures with clear provenance. Never infer a weekly quota from an ambiguous response.

Use Python 3.13 with `paho-mqtt>=2.1,<3` installed:

```console
python3 -m unittest discover -s ai_usage_proxy/test -p 'test_*.py' -v
ruff check ai_usage_proxy/rootfs/app ai_usage_proxy/test
mypy --ignore-missing-imports --check-untyped-defs ai_usage_proxy/rootfs/app
```

An optional browser check uses Playwright/Chromium and local fake providers only:

```console
python3 ai_usage_proxy/test/browser_dashboard.py
```

A separate broker integration check uses a disposable local MQTT broker:

```console
MQTT_TEST_PORT=1883 python3 ai_usage_proxy/test/mqtt_integration.py
```

The container pins the official Codex Linux x64 npm binary package at `0.164.0` with a SHA-256 check. It runs privately over stdio and never starts a model turn for monitoring. To update it, verify the package checksum, protocol tests, and the amd64 Alpine container together. Build with the base image in `build.yaml`; no publishing is needed for local verification.

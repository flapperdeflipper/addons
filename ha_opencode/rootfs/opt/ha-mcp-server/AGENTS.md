# Home Assistant OpenCode Rules

You are working directly within a Home Assistant installation. Your working directory is `/homeassistant`, which is the live Home Assistant configuration directory.

## CRITICAL: User Consent and Scope Rules

You MUST follow these rules strictly:

1. **Never exceed the user's request** - Do exactly what the user asks, nothing more. Do not "improve" or "enhance" beyond the stated scope.

2. **Never make changes without explicit approval** - Before modifying ANY file:
   - Show the user exactly what you plan to change
   - Wait for their explicit confirmation ("yes", "go ahead", "do it", etc.)
   - If they haven't approved, DO NOT proceed

3. **Ask, don't assume** - If the user's request is ambiguous:
   - Ask clarifying questions first
   - Present options and let them choose
   - Never guess at their intent

4. **Read-only by default** - When investigating or troubleshooting:
   - Only read files and gather information
   - Present findings and recommendations
   - Wait for user instruction before making any changes

5. **One change at a time** - When making approved changes:
   - Make the minimum change needed
   - Show what was changed
   - Let the user verify before proceeding to any next step

6. **No unsolicited modifications** - Never:
   - "Clean up" code the user didn't ask about
   - Add features they didn't request
   - Refactor working configurations
   - Fix issues they haven't mentioned

7. **Respect "no"** - If a user declines a suggestion, do not:
   - Repeat the suggestion
   - Make the change anyway
   - Try to convince them otherwise

## Safety Guidelines

- NEVER expose or display contents of `secrets.yaml`
- NEVER include API keys, tokens, or passwords in responses
- NEVER make changes without explicit user approval
- NEVER access `.storage/`, `.cloud/`, or other internal directories
- NEVER attempt to modify Home Assistant's internal databases or registries
- NEVER parse internal JSON files for entity/device/area information
- ALWAYS prefer MCP tools for querying runtime state over internal file access
- ALWAYS use `call_service` through MCP rather than modifying state files
- WARN users before changes that require restart vs reload
- SUGGEST backing up files before major modifications
- CHECK configuration validity when possible
- ALWAYS confirm with user before writing, editing, or deleting any file

## RESTRICTED: Internal Home Assistant Directories

**NEVER read, modify, or directly interact with these internal directories:**

| Directory | Contains | Use Instead |
|-----------|----------|-------------|
| `.storage/` | Entity/device/area registries, auth, system state | MCP: `get_devices`, `get_areas`, `get_entity_details` |
| `.cloud/` | Home Assistant Cloud state | N/A - managed by HA Cloud |
| `deps/` | Python dependency cache | N/A - managed by HA Core |
| `tts/` | Text-to-speech cache | N/A - managed by TTS integration |
| `home-assistant_v2.db` | History SQLite database | MCP: `get_history`, `get_logbook` |
| `home-assistant.log` | Raw system logs | MCP: `get_error_log` |

These contain internal Home Assistant state that:

1. Is managed exclusively by Home Assistant core
2. Can corrupt your installation if modified incorrectly
3. May be overwritten by Home Assistant at any time
4. Has no stable schema or format guarantees

**For information that seems to require internal access, there is always a proper alternative:**

- Need entity details? -> Read configuration files OR use `get_entity_details`
- Need device info? -> Use `get_devices` MCP tool
- Need to check history? -> Use `get_history` MCP tool
- Need to see errors? -> Use `get_error_log` MCP tool

## Environment Context

- You are running inside the OpenCode app
- The current directory (`/homeassistant`) contains the live Home Assistant configuration
- Changes to YAML files here directly affect the Home Assistant instance
- If add-on folder access is enabled, `/addons` and `/addon_configs` are available for Home Assistant add-on development. Treat `/addon_configs` as sensitive and only inspect or modify these folders when the user explicitly asks.
- You may have access to MCP tools for interacting with Home Assistant (check with the user)

## Skills: where the detailed procedures live

The add-on ships skills that hold the full procedure for each kind of Home
Assistant work. They are loaded on demand with the `skill` tool, so they cost
nothing until the task needs them. **Load the matching skill before you start** —
each one carries current syntax, the tool to prefer, and the mistakes worth
avoiding, none of which is repeated here.

| Load this skill | When the request is about |
|---|---|
| `home-assistant-configuration` | Writing or changing YAML: automations, scripts, scenes, templates, integrations, packages, helpers. Also validation, backups, and whether a change needs a reload or a restart. |
| `home-assistant-troubleshooting` | Something is broken, missing, unavailable, or behaving oddly. Bounded diagnosis that ends in a recommendation, not a fix. |
| `home-assistant-dashboard-ui` | Lovelace dashboards, views, cards, badges, themes, and screenshot verification of the result. |
| `home-assistant-zigbee-esphome` | Zigbee/ZHA/Z2M devices, cascade renames, stale-device cleanup, mesh maps, ESPHome, and device firmware updates. |
| `home-assistant-development` | Writing code rather than configuration: custom integrations, add-ons, native `llm.py` tool providers, MCP servers. |

More than one can apply — diagnose with the troubleshooting skill, then load the
configuration skill when the user approves a fix. The consent, scope, secret and
internal-directory rules above are always in force and are never relaxed by a
skill.

## Home Context

The add-on assembles context about *this specific installation* and loads it before the user's first message. You do not need to fetch any of it. Depending on the user's settings, some or all of these are present:

- **Install briefing** — a generated snapshot: Home Assistant version, areas, entity counts per domain, how the configuration is split up, which custom components are installed. It is orientation, **not live state** — re-check anything current with the MCP tools or `hab`. It may be absent or partial when Home Assistant was still starting.
- **`AGENTS.local.md`** — the user's own standing instructions, if they created that file. Follow them. This file (`AGENTS.md`) takes precedence where the two conflict, and the consent and safety rules above are never overridden.

## Home Assistant Interaction Model

Four ways to interact, each with a job the others do badly.

### 1. Configuration files (YAML)

The source of truth for defined behaviour: automations, scripts, scenes,
blueprints, integrations, templates, packages, customizations, and YAML-mode
dashboards. These files are designed for editing. Load
`home-assistant-configuration` before changing one — it carries the mandatory
style guide, the safe-write path, and the reload/restart rules.

### 2. MCP tools (runtime API)

Real-time interaction with the running instance:

- `get_states`, `search_entities`, `get_entity_details`, `get_home_context` — current state and compact area/domain/entity context. Prefer `get_home_context` over broad state dumps.
- `call_service` — control devices (with confirmation), and read from services that answer with data (`recorder.get_statistics`, `weather.get_forecasts`, `calendar.get_events`, `todo.get_items`); the response comes back automatically
- `get_history`, `get_logbook`, `get_calendar_events` — historical and calendar data; supplied timestamps must include `Z` or a UTC offset
- `get_devices`, `get_areas` — device and area registry
- `write_config_safe`, `validate_config`, `check_config_syntax` — safe config writing with validation, content protection and backup
- `get_integration_docs`, `get_breaking_changes` — current syntax, before writing any integration configuration
- `diagnose_entity`, `get_error_log`, `detect_anomalies`, `get_suggestions` — diagnosis
- `get_supervisor_health`, `get_supervisor_resolution`, `get_backup_posture`, `get_store_audit`, `get_supervisor_metrics`, `get_support_logs` — bounded, credential-redacted system evidence
- `watch_firmware_update`, `get_available_updates`, `update_component` — updates
- `screenshot_url` — visual verification (requires the `screenshot_enabled` option)
- `get_agent_capabilities`, `get_ha_llm_development_guide` — capability and native-LLM development information

Which tools exist depends on the add-on's MCP tool profile. If a tool you expect
is missing, the profile is reduced — say so instead of working around it.

### 3. hab CLI (Home Assistant Builder)

A CLI designed for AI agents, pre-authenticated via the Supervisor token. It
is the primary path for dashboards, areas/floors/zones/labels, helpers,
scripts, scenes, blueprints, backups, people, categories, to-do lists,
notifications, integrations, repairs, events and templates — the registry-level
work that has no YAML file behind it. `hab` prints human-readable text by
default; use `--json` for structured output; `hab --help` or
`hab <command> --help` for full, version-accurate usage at runtime.

### 4. zigporter CLI (Zigbee toolkit)

Zigbee device management, and the only tool here that **cascades a rename**
across automations, scripts, scenes and every Lovelace dashboard atomically.
`hab` renames one thing and leaves the references dangling. Also handles
device inspection across ZHA/Z2M/HA, stale-device cleanup, and mesh
visualization. Dry-run is the default for renames — always preview before
`--apply`; the `migrate` command is interactive and must NOT be used by an
agent; `zigporter --help` for version-accurate usage. Load the
`home-assistant-zigbee-esphome` skill before any of this work.

### Choosing between them

| Task | Use |
|---|---|
| Create/edit automations, scripts, scenes, templates | YAML + `write_config_safe` |
| Check current state, control a device | MCP (`get_home_context`, `call_service`) |
| Troubleshoot | MCP (`diagnose_entity`, `get_error_log`, `get_supervisor_health`) |
| Dashboards, areas, helpers, backups, blueprints, people | `hab` |
| Verify a UI change | `screenshot_url` |
| Rename an entity or device with all references | `zigporter rename-entity` / `rename-device` |
| Inspect a Zigbee device, map the mesh, clean up stale devices | `zigporter` |
| Device firmware updates | `watch_firmware_update` |
| Core/OS/Supervisor updates | `get_available_updates`, `update_component` |

### Internal directories

Home Assistant manages internal state in `.storage/` and friends. They are not
designed for direct access, have no stable schema, and can corrupt the
installation if modified. Use configuration files or MCP tools instead — see
the restricted-directory table above.

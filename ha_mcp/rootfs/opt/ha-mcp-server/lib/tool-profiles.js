/**
 * The Home Assistant MCP surface is useful, but its full schema is expensive
 * for local models. Profiles deliberately remove capabilities rather than
 * merely telling the model not to use them.
 */

const COMPACT_TOOL_NAMES = [
  "get_states",
  "search_entities",
  "get_entity_details",
  "get_home_context",
  "get_services",
  "get_history",
  "get_logbook",
  "get_config",
  "get_agent_capabilities",
  "get_areas",
  "get_devices",
  "get_error_log",
  "list_automation_traces",
  "get_automation_trace",
  "get_supervisor_health",
  "get_supervisor_resolution",
  "get_backup_posture",
  "get_support_logs",
  "get_store_audit",
  "get_supervisor_metrics",
  "render_template",
  "get_calendars",
  "get_calendar_events",
  "get_todo_items",
  "detect_anomalies",
  "get_suggestions",
  "diagnose_entity",
  "esphome_list_devices",
  "esphome_troubleshoot",
];

const CONFIGURATION_TOOL_NAMES = [
  ...COMPACT_TOOL_NAMES,
  "get_ha_llm_development_guide",
  "get_integration_docs",
  "get_breaking_changes",
  "check_config_syntax",
  "validate_config",
  "write_config_safe",
  "esphome_config_read",
  "esphome_config_validate",
  "esphome_config_migrate",
  "esphome_config_update",
  "esphome_config_create",
  "esphome_boards",
  "esphome_device_metadata",
  "esphome_yaml_search",
  "esphome_file",
];

// Tools that write configuration files: Home Assistant's YAML and the
// ESPHome device YAML (create, update, migrate, companion files, restores
// from history, clone/rename, metadata and API-key edits). Where the config
// lives in git and a merge deploys it, those changes go through pull
// requests instead; everything that acts at runtime stays.
const CONFIG_WRITE_TOOL_NAMES = [
  "write_config_safe",
  "esphome_config_create",
  "esphome_config_update",
  "esphome_config_migrate",
  "esphome_file",
  "esphome_history",
  "esphome_device_lifecycle",
  "esphome_device_metadata",
  "esphome_api_key",
];

export const TOOL_PROFILES = Object.freeze({
  compact: Object.freeze({
    name: "compact",
    title: "Compact diagnostics",
    description: "Read-only state, history, diagnostics, and focused home context.",
    toolNames: new Set(COMPACT_TOOL_NAMES),
  }),
  configuration: Object.freeze({
    name: "configuration",
    title: "Configuration",
    description: "Compact diagnostics plus documentation, validation, safe configuration writes, and decision notes.",
    toolNames: new Set(CONFIGURATION_TOOL_NAMES),
  }),
  deployed: Object.freeze({
    name: "deployed",
    title: "Deployed from git",
    description: "Every capability except writing configuration files: the configuration lives in git and is deployed on merge.",
    toolNames: null,
    excludedToolNames: new Set(CONFIG_WRITE_TOOL_NAMES),
  }),
  full: Object.freeze({
    name: "full",
    title: "Full",
    description: "Every Home Assistant MCP capability, including control, administration, updates, firmware, and visual verification.",
    toolNames: null,
  }),
});

export const TOOL_PROFILE_NAMES = Object.freeze(Object.keys(TOOL_PROFILES));

export function normalizeToolProfile(value, { fallback = "full", onInvalid = null } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (TOOL_PROFILES[normalized]) return normalized;
  if (normalized && onInvalid) onInvalid(normalized);
  return fallback;
}

export function getToolProfile(value) {
  return TOOL_PROFILES[normalizeToolProfile(value)];
}

export function isToolAllowedInProfile(name, profile) {
  const selected = getToolProfile(profile);
  if (selected.excludedToolNames?.has(name)) return false;
  return !selected.toolNames || selected.toolNames.has(name);
}

export function filterToolsForProfile(tools, profile) {
  return tools.filter((tool) => isToolAllowedInProfile(tool.name, profile));
}

export function profileDisabledToolMessage(name, profile) {
  const selected = getToolProfile(profile);
  return (
    `The '${name}' tool is unavailable in the ${selected.name} MCP tool profile.` +
    (selected.excludedToolNames?.has(name)
      ? " The configuration is deployed from git: change it in the repository and open a pull request."
      : " Select the full profile to use it.")
  );
}

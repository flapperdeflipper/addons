import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TOOL_PROFILES,
  filterToolsForProfile,
  getToolProfile,
  isToolAllowedInProfile,
  normalizeToolProfile,
  profileDisabledToolMessage,
} from "../lib/tool-profiles.js";

const tools = [
  { name: "get_home_context" },
  { name: "get_integration_docs" },
  { name: "write_config_safe" },
  { name: "esphome_list_devices" },
  { name: "esphome_troubleshoot" },
  { name: "esphome_config_read" },
  { name: "esphome_config_migrate" },
  { name: "esphome_config_update" },
  { name: "esphome_boards" },
  { name: "call_service" },
  { name: "hab_run" },
];

describe("MCP tool profiles", () => {
  it("defaults unknown values to the backwards-compatible full surface", () => {
    expect(normalizeToolProfile()).toBe("full");
    expect(normalizeToolProfile("not-a-profile")).toBe("full");
    expect(getToolProfile("FULL").name).toBe("full");
  });

  it("keeps only diagnostics in the compact profile", () => {
    expect(filterToolsForProfile(tools, "compact").map((tool) => tool.name)).toEqual([
      "get_home_context",
      "esphome_list_devices",
      "esphome_troubleshoot",
    ]);
    expect(isToolAllowedInProfile("call_service", "compact")).toBe(false);
  });

  it("adds safe configuration tools without administrative capabilities", () => {
    expect(filterToolsForProfile(tools, "configuration").map((tool) => tool.name)).toEqual([
      "get_home_context",
      "get_integration_docs",
      "write_config_safe",
      "esphome_list_devices",
      "esphome_troubleshoot",
      "esphome_config_read",
      "esphome_config_migrate",
      "esphome_config_update",
      "esphome_boards",
    ]);
    expect(isToolAllowedInProfile("hab_run", "configuration")).toBe(false);
  });

  it("leaves the full profile unchanged and explains scoped rejections", () => {
    expect(filterToolsForProfile(tools, "full")).toEqual(tools);
    expect(isToolAllowedInProfile("call_service", "full")).toBe(true);
    expect(profileDisabledToolMessage("call_service", "compact")).toContain("full profile");
  });

  it("drops only the config-writing tools in the deployed profile", () => {
    expect(filterToolsForProfile(tools, "deployed").map((tool) => tool.name)).toEqual([
      "get_home_context",
      "get_integration_docs",
      "esphome_list_devices",
      "esphome_troubleshoot",
      "esphome_config_read",
      "esphome_boards",
      "call_service",
      "hab_run",
    ]);
    expect(isToolAllowedInProfile("write_config_safe", "deployed")).toBe(false);
    expect(profileDisabledToolMessage("write_config_safe", "deployed")).toContain("pull request");
  });

  it("names only tools the server defines in the deployed exclusions", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    for (const name of TOOL_PROFILES.deployed.excludedToolNames) {
      expect(source, `${name} is not a tool in index.js`).toContain(`name: "${name}"`);
    }
  });
});

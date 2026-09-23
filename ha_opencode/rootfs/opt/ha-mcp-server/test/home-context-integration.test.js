/**
 * End-to-end check of the pipeline that `generate-home-context.mjs` runs:
 * scan a real configuration directory on disk, fold in whatever Home Assistant
 * returned, and render both context files.
 *
 * The generator script itself is a thin wrapper around these calls; this covers
 * the logic it depends on against real filesystem behaviour rather than fakes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { buildBriefingFacts, scanConfigLayout } from "../lib/home-facts.js";
import { HOME_BRIEFING_BUDGET_BYTES, renderHomeBriefing } from "../lib/home-briefing.js";
import { byteLength } from "../lib/context-budget.js";

const FS_API = { readFile, readdir, stat };

let configDir;

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "ha-context-"));

  await writeFile(
    join(configDir, "configuration.yaml"),
    [
      "default_config:",
      "",
      "homeassistant:",
      "  name: Home",
      "  packages: !include_dir_named packages",
      "",
      "automation: !include automations.yaml",
      "script: !include scripts.yaml",
      "template: !include_dir_merge_list templates/",
      "",
      "http:",
      "  api_password: !secret http_password",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(configDir, "automations.yaml"),
    ["- id: '1699999999999'", "  alias: Morning lights", "- id: '1700000000000'", "  alias: Night lights"].join("\n"),
    "utf8",
  );
  await writeFile(join(configDir, "scripts.yaml"), "good_morning:\n  sequence: []\n", "utf8");
  await writeFile(join(configDir, "secrets.yaml"), "http_password: hunter2hunter2\n", "utf8");

  await mkdir(join(configDir, "packages"), { recursive: true });
  await writeFile(join(configDir, "packages", "lights.yaml"), "# lights\n", "utf8");
  await mkdir(join(configDir, "custom_components", "hacs"), { recursive: true });
  await mkdir(join(configDir, ".git"), { recursive: true });
});

afterAll(async () => {
  if (configDir) await rm(configDir, { recursive: true, force: true });
});

const LIVE = {
  config: {
    version: "2026.7.2",
    time_zone: "Europe/Oslo",
    unit_system: { temperature: "°C", length: "km" },
    language: "en",
    state: "RUNNING",
    latitude: 59.91,
    longitude: 10.75,
  },
  supervisorInfo: { operating_system: "Home Assistant OS 14.2", machine: "green" },
  states: [{ entity_id: "light.kitchen" }, { entity_id: "sensor.power" }, { entity_id: "sensor.temp" }],
  areas: [{ area_id: "kitchen", name: "Kitchen", floor_id: "ground" }],
  floors: [{ floor_id: "ground", name: "Ground floor" }],
  entityRegistry: [
    { entity_id: "light.kitchen", platform: "hue" },
    { entity_id: "sensor.power", platform: "esphome" },
  ],
  degraded: [],
  offline: false,
};

describe("home context generation", () => {
  it("produces a complete briefing from a real config directory plus live data", async () => {
    const layout = await scanConfigLayout(FS_API, configDir);
    const facts = buildBriefingFacts({
      generatedAt: "2026-07-26T09:00:00Z",
      layout,
      live: LIVE,
      addon: { mcp: true, lsp: true, screenshot: false, addonAccess: false, restrictSensitiveFiles: true },
      z2mConfigured: false,
    });
    const briefing = renderHomeBriefing(facts);

    expect(briefing.markdown).toContain("Home Assistant 2026.7.2");
    expect(briefing.markdown).toContain("Packages are in use");
    expect(briefing.markdown).toContain("UI-managed");
    expect(briefing.markdown).toContain("Kitchen (Ground floor)");
    expect(briefing.markdown).toContain("hacs");
    expect(briefing.markdown).toContain("git repository");
    expect(briefing.bytes).toBeLessThanOrEqual(HOME_BRIEFING_BUDGET_BYTES + 1);
  });

  it("never leaks secrets or coordinates into the briefing", async () => {
    const layout = await scanConfigLayout(FS_API, configDir);
    const facts = buildBriefingFacts({ generatedAt: "2026-07-26T09:00:00Z", layout, live: LIVE, addon: null });
    const { markdown } = renderHomeBriefing(facts);

    // secrets.yaml is detected as present but never read into the briefing
    expect(markdown).not.toContain("hunter2hunter2");
    expect(markdown).not.toContain("59.91");
    expect(markdown).not.toContain("10.75");
  });

  it("still produces a useful briefing when Home Assistant is unreachable", async () => {
    const layout = await scanConfigLayout(FS_API, configDir);
    const facts = buildBriefingFacts({
      generatedAt: "2026-07-26T09:00:00Z",
      layout,
      live: null,
      addon: { mcp: true, lsp: true, screenshot: false, addonAccess: false, restrictSensitiveFiles: true },
    });
    const briefing = renderHomeBriefing(facts);

    expect(briefing.includedSections).toContain("layout");
    expect(briefing.markdown).toContain("Packages are in use");
    expect(briefing.markdown).not.toContain("## Areas");
  });

  it("reports the degraded sections when Home Assistant answered only partially", async () => {
    const layout = await scanConfigLayout(FS_API, configDir);
    const facts = buildBriefingFacts({
      generatedAt: "2026-07-26T09:00:00Z",
      layout,
      live: { ...LIVE, areas: null, degraded: ["areas"] },
      addon: null,
    });
    const briefing = renderHomeBriefing(facts);
    expect(briefing.markdown).toContain("Core was not reachable");
    expect(briefing.markdown).toContain("areas");
  });
});

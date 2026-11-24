/**
 * Runs the real `generate-home-context.mjs` against temporary directories.
 *
 * The script lives in /usr/local/bin and imports the shared libraries by their
 * absolute in-container path, so the only thing rewritten here is that import
 * prefix. Everything else — flag handling, atomic writes, the offline path,
 * cleanup when a feature is turned off — is the shipped code.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";

const run = promisify(execFile);

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(SERVER_DIR, "..", "..", "usr", "local", "bin", "generate-home-context.mjs");

const scratchDirs = [];

async function scratch(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Copy the script with only its library import prefix repointed. */
async function stageScript() {
  const dir = await scratch("home-context-script-");
  const libUrl = pathToFileURL(join(SERVER_DIR, "lib")).href;
  const source = (await readFile(SOURCE, "utf8")).replaceAll("/opt/ha-mcp-server/lib/", `${libUrl}/`);
  const staged = join(dir, "generate-home-context.mjs");
  await writeFile(staged, source, "utf8");
  return staged;
}

let script;
let configDir;
let outputDir;
beforeEach(async () => {
  script = script ?? (await stageScript());
  configDir = await scratch("home-context-config-");
  outputDir = await scratch("home-context-out-");

  await writeFile(
    join(configDir, "configuration.yaml"),
    ["default_config:", "automation: !include automations.yaml"].join("\n"),
    "utf8",
  );
  await writeFile(join(configDir, "automations.yaml"), "- id: '1'\n  alias: One\n", "utf8");
  await mkdir(join(configDir, "custom_components", "hacs"), { recursive: true });
});

function invoke(env) {
  return run(process.execPath, [script], {
    env: {
      ...process.env,
      HOME_CONTEXT_SINGLE_PASS: "true",
      HOME_CONTEXT_CONFIG_DIR: configDir,
      HOME_CONTEXT_OUTPUT_DIR: outputDir,
      // No Supervisor token: exercises the offline path deterministically
      SUPERVISOR_TOKEN: "",
      ...env,
    },
    timeout: 30000,
  });
}

const briefingPath = () => join(outputDir, "home-briefing.md");

describe("generate-home-context", () => {
  it("writes a briefing from the configuration directory alone", async () => {
    const { stdout } = await invoke({ OPENCODE_HOME_BRIEFING: "true" });

    expect(stdout).toContain("briefing written from the configuration directory only");
    const briefing = await readFile(briefingPath(), "utf8");
    expect(briefing).toContain("Home Assistant install briefing");
    expect(briefing).toContain("Custom components (1): hacs");
    expect(briefing).toContain("`automations.yaml`: 1 entry");
  });

  it("reports the add-on capabilities it was told about", async () => {
    await invoke({
      OPENCODE_HOME_BRIEFING: "true",
      OPENCODE_MCP_ENABLED: "true",
      OPENCODE_LSP_ENABLED: "true",
      SCREENSHOT_ENABLED: "false",
    });

    const briefing = await readFile(briefingPath(), "utf8");
    expect(briefing).toContain("Home Assistant MCP tools");
    expect(briefing).toContain("Not available:");
    expect(briefing).toContain("screenshot tool");
  });

  it("writes no briefing when the feature is off, and removes a stale one", async () => {
    await invoke({ OPENCODE_HOME_BRIEFING: "true" });
    expect(existsSync(briefingPath())).toBe(true);

    await invoke({ OPENCODE_HOME_BRIEFING: "false" });
    expect(existsSync(briefingPath())).toBe(false);
  });

  it("leaves no temporary files behind", async () => {
    await invoke({ OPENCODE_HOME_BRIEFING: "true" });
    const entries = await readdir(outputDir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("exits cleanly with the briefing off", async () => {
    const { stdout } = await invoke({ OPENCODE_HOME_BRIEFING: "false" });
    expect(stdout).not.toContain("fatal");
    expect(existsSync(briefingPath())).toBe(false);
  });
});

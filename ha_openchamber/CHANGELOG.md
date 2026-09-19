## 1.1.2

- **Installs `git` in the image** — the sessions UI lists branches and worktrees of the OpenCode workspace through simple-git, which shells out to the system `git` binary; 1.1.1 and earlier shipped without it, so every request failed with `spawn git ENOENT`. Dependency addition only.

## 1.1.1

- **Ships the real OpenCode CLI on PATH** — upstream's server resolves an `opencode` binary at startup even in external-server mode (`OPENCODE_SKIP_START`), so every boot crashed with `Unable to locate the opencode CLI on PATH` and s6 restarted the add-on forever: nothing image-less can satisfy that lookup. The Dockerfile now installs the same certified `opencode-ai` 1.18.31 pin as the OpenCode add-on (build-time version assertion, non-matching platform binaries trimmed, `opencode --version` asserted), so the binary upstream wants is genuinely on PATH. It is still never spawned: all API calls keep proxying to the OpenCode add-on's LAN server.

# Changelog
All notable changes to this project will be documented in this file.

## 1.1.0

- **Trusted-remote allowlist replaces basic auth on the LAN port** — the mapped `4097/tcp` no longer prompts for credentials. The proxy now only accepts loopback plus the addresses in the new **LAN trusted remotes** option (IPs or CIDRs, e.g. your nginx/OAuth proxy's source); every other request — WebSocket upgrades included — is redirected to the new **LAN redirect URL** (e.g. `https://openchamber.pl4.dev`, where the OAuth proxy authenticates properly) or refused with 403 when unset. Each rejection is logged with the source address, so an unknown proxy IP is discovered from the add-on log and then added to the list; an empty list means loopback-only. The env-gated basic-auth code stays in the proxy for opt-in use. Ingress (Home Assistant login) and the OpenCode server credentials are unchanged.

## 1.0.1

- **Mirrors the OpenCode add-on's directory mounts** — 1.0.0 shipped with no `map` entries, so the container only had its own `/data`: `/homeassistant`, `/local_apps`, `/addon_configs` and `/share` were missing, breaking anything that expected workspace paths to exist locally. All four now mount read-write exactly as in ha_opencode, the server runs with `/homeassistant` as its working directory (matching pre-split behaviour), and the image `WORKDIR` follows. Still no Supervisor or Home Assistant API access — mounts are filesystem-level only.

## 1.0.0

- **First release — OpenChamber as its own add-on** — the OpenChamber browser UI for OpenCode conversations, split out of the OpenCode add-on (ha_opencode 2.14.0 removes its bundled copy). Runs the pinned `@openchamber/web` 1.24.1 in a dedicated slim image (base-debian + Node 24.21.0, Ingress-patched bundle, first-party ingress proxy) with no OpenCode runtime, terminal, or MCP server of its own. Directory mounts mirror the OpenCode add-on (`/homeassistant`, `/local_apps`, `/addon_configs`, `/share`) so workspace paths behave identically; there is still no Supervisor or Home Assistant API access.
- **Attaches to the OpenCode add-on's LAN server instead of spawning OpenCode** — upstream's external-server mode (`OPENCODE_HOST` + `OPENCODE_SKIP_START`): the add-on auto-discovers the Docker host gateway (explicit `opencode_host` override supported), waits up to two minutes for the server, and authenticates every API call with the shared basic-auth credentials. Sessions shown are exactly the OpenCode add-on's; OpenChamber keeps none of its own.
- **Basic authentication on the LAN web UI** — the mappable 4097/tcp proxy instance now requires HTTP Basic auth (constant-time comparison, 401 + `WWW-Authenticate` on plain requests and WebSocket upgrades alike) using the same `opencode_username`/`opencode_password` options. The Home Assistant Ingress listener keeps its strict remote allowlist and stays authentication-free — Home Assistant's login covers it. This is the pattern the OpenCode add-on's LAN server adopts in the same release, so one credential pair protects both exposed ports.

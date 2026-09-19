## 1.1.4

- **Stops the build-time bundle patch from breaking root-hosted domains — actually fixes the blank terminal** — 1.1.3 fixed the runtime proxy, but the corruption was baked in earlier: `patch-ingress.js` rewrote every `"/assets/…"` literal in the bundle's JavaScript to relative `assets/…` at image build time (and failed the build if any survived). Correct under Ingress, where the document base carries the ingress path — but on a domain hosted at the root (straight nginx → LAN port, e.g. `openchamber.pl4.dev`), a relative URL inside a chunk under `/assets/` resolves to `/assets/assets/…`: the terminal surface's `new URL("/assets/ghostty-vt.wasm", import.meta.url)` fetched the SPA's index.html (`CompileError: expected magic word … found 3c 21 64 6f`) and the Nerd Font 404'd, leaving the terminal permanently blank. The patcher now leaves JS bodies byte-identical to upstream; the runtime ingress proxy adds the ingress prefix per request when one is present (behaviour covered by the 1.1.3 tests).

## 1.1.3

- **LAN proxy keeps absolute asset URLs — fixes the blank terminal** — the proxy's Ingress URL rewriting rewrote `"/assets/…"` literals inside served JavaScript to relative `assets/…` on the LAN listener as well, where there is no base path; resolved against a chunk under `/assets/`, `new URL("assets/…", import.meta.url)` became `/assets/assets/…` and 404'd. The terminal surface's two lazily-fetched resources — the ghostty VT WASM (the emulator core) and the Nerd Font — were the only bundle URLs of that shape, so the terminal panel stayed blank at the public hostname while Ingress kept working. Without an Ingress path the proxy now passes content through untouched; with one, behaviour is unchanged.

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

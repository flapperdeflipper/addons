## 1.3.6

- **Changed** — base image pin `ghcr.io/flapperdeflipper/agent-base` -> `1.1.1` (automated base-image update).

## 1.3.5

- **Re-publish of 1.3.4** — version bump only, no code change. The 1.3.4 image was never built: its merge landed in the window between the default-branch rename (master -> main) and the build-workflow trigger update (#146), so the push matched no workflow trigger and Docker Hub has no 1.3.4 tag. 1.3.5 re-triggers the build of identical content.

## 1.3.4

- **Changed** — the **OpenCode server username** option is gone. ha_opencode 3.0.0 fixed the LAN server username to OpenCode's default `opencode` (its `server_username` option was removed), so this add-on now always authenticates as `opencode` with the shared password. Requires ha_opencode 3.0.0+.

## 1.3.3

- **Changed** — upstream OpenChamber bundle pin `@openchamber/web` -> `1.24.2` (bugfix release; notably stops the app from starting MCP servers and background work for every saved project/worktree on open - a runaway-memory fix that pairs well with the shared mcp-hub migration - plus chat/git/mobile fixes).

## 1.3.2

- **Changed** — base image pin `ghcr.io/flapperdeflipper/agent-base` -> `1.1.0` (automated base-image update).

## 1.3.1

- **Fixes Node MCP clients deadlocking against the agent MCP server** — in stateless mode the SDK's `StreamableHTTPServerTransport` still opened an empty SSE stream for standalone `GET /mcp`, and Node SDK clients (opencode's remote MCP client among them) then never settled subsequent JSON POST responses: `initialize` succeeded but `tools/list` hung forever, so the tools never appeared in opencode sessions. Python clients (the LiteLLM gateway) were unaffected, which is why the earlier round-trip checks passed. The server now answers `GET /mcp` with a spec-compliant `405` (`Allow: POST, DELETE`) — it never pushes messages, so there is no stream to offer — and Node clients connect, list and call tools immediately.

# Changelog
All notable changes to this project will be documented in this file.

## 1.3.0

- **Changed** — the toolchain layers (exact Node runtime, certified OpenCode CLI, unix toolset) moved to the shared [`agent-base`](https://github.com/flapperdeflipper/agent-base) image, shared with the OpenCode and Terminal add-ons; the add-on Dockerfile now layers only the OpenChamber bundle, ingress patch and s6 services on `ghcr.io/flapperdeflipper/agent-base`.
- **Removed** — the apt layer (including the temporary g++/make install/purge dance — the base ships the build toolchain permanently).

## 1.2.2

- **`openchamber_note_delete` prints the remaining context again** — the REST DELETE endpoint returns the bare context object while the handler looked for a `{context}` wrapper, so every successful delete ended with the confusing "no context returned" line. The handler now formats whichever shape arrives (`result.context ?? result`, same defensive form as `openchamber_note_edit`).

## 1.2.1

- **MCP token: `!secret <key>` resolves at start, never at save** — the add-on options form turns a typed `!secret` value into plaintext on save (the Supervisor resolves before storing), which both leaks the secret into options and leaves a quoted literal that never authenticates. The MCP service now normalizes the `mcp_token` option itself at start: surrounding quotes are stripped, a `!secret <key>` reference is resolved from `/homeassistant/secrets.yaml` (python3+PyYAML, litellm add-on convention), and anything else is used as the literal token. Only the key name is ever logged; an unresolvable reference idles the service with an actionable error instead of serving with a broken token.

## 1.2.0

- **Agent MCP server for Project Notes (notes, todos, plans)** — new opt-in service (`mcp_enabled`, `mcp_token`) serving OpenChamber's Project Notes surface to agent clients such as the OpenCode add-on over streamable HTTP on `4100`/tcp (internal add-on network only; never host-mapped) behind a required bearer token. Eight tools (`openchamber_context`, `openchamber_note_add/edit/delete`, `openchamber_todo_add/toggle/delete`, `openchamber_plan_read`) proxy the loopback-only REST API (`127.0.0.1:3010/api/project-context/:projectId`) — the same transport shape as the OpenCode add-on's ha-mcp-server HTTP mode (stateless per-request `StreamableHTTPServerTransport`, `node:http` listener, constant-time bearer check). Project ids follow OpenChamber's own `path_<base64url>` rule with the `path_sha256_<digest>` stem for over-long ids; todos go through serialized read-modify-write over the whole-array API. The web UI and agent sessions share one store by construction: the JSON files under `/data/.config/openchamber/projects/` stay owned by the OpenChamber server alone.

## 1.1.5

- **Installs an interactive toolset for the terminal** — the image only carried what the server needed, so the built-in terminal lacked basics (`ps`, `vim`, `jq`, archives, …). Adds the requested toolset: `bats` (+ assert/file/support), `bc`, `binutils`, `bubblewrap`, `coreutils`, `direnv`, `file`, `findutils`, `fzf`, `gawk`, `gettext`, `gh`, `glab`, `grc`, `highlight`, `ipcalc`, `jo`, `jq`, `moreutils`, `ncdu`, `netcat-openbsd`, `openssl`, `openssh-client`, `p7zip`, `pigz`, `procps`, `progress`, `psutils`, `python3` (+ venv/virtualenv/virtualenvwrapper/yaml), `rsync`, `sqlite3`, `sudo`, `telnet`, `tmux`, `tree`, `unzip`, `vim`, `wget`, `xz-utils`, `zoxide`, plus `-dev` headers (`libffi`, `libpcre2`, `libpq`, `libyaml`) and `libtool`. Mirrors the tooling of the OpenCode add-on image where it is terminal-relevant (chromium and its automation-only libraries stay out; runtime libraries resolve as dependencies). `git` arrived in 1.1.2.

## 1.1.4

- **Stops the build-time bundle patch from breaking root-hosted domains — actually fixes the blank terminal** — 1.1.3 fixed the runtime proxy, but the corruption was baked in earlier: `patch-ingress.js` rewrote every `"/assets/…"` literal in the bundle's JavaScript to relative `assets/…` at image build time (and failed the build if any survived). Correct under Ingress, where the document base carries the ingress path — but on a domain hosted at the root (straight nginx → LAN port, e.g. `openchamber.pl4.dev`), a relative URL inside a chunk under `/assets/` resolves to `/assets/assets/…`: the terminal surface's `new URL("/assets/ghostty-vt.wasm", import.meta.url)` fetched the SPA's index.html (`CompileError: expected magic word … found 3c 21 64 6f`) and the Nerd Font 404'd, leaving the terminal permanently blank. The patcher now leaves JS bodies byte-identical to upstream; the runtime ingress proxy adds the ingress prefix per request when one is present (behaviour covered by the 1.1.3 tests).

## 1.1.3

- **LAN proxy keeps absolute asset URLs — fixes the blank terminal** — the proxy's Ingress URL rewriting rewrote `"/assets/…"` literals inside served JavaScript to relative `assets/…` on the LAN listener as well, where there is no base path; resolved against a chunk under `/assets/`, `new URL("assets/…", import.meta.url)` became `/assets/assets/…` and 404'd. The terminal surface's two lazily-fetched resources — the ghostty VT WASM (the emulator core) and the Nerd Font — were the only bundle URLs of that shape, so the terminal panel stayed blank at the public hostname while Ingress kept working. Without an Ingress path the proxy now passes content through untouched; with one, behaviour is unchanged.

## 1.1.2

- **Installs `git` in the image** — the sessions UI lists branches and worktrees of the OpenCode workspace through simple-git, which shells out to the system `git` binary; 1.1.1 and earlier shipped without it, so every request failed with `spawn git ENOENT`. Dependency addition only.

## 1.1.1

- **Ships the real OpenCode CLI on PATH** — upstream's server resolves an `opencode` binary at startup even in external-server mode (`OPENCODE_SKIP_START`), so every boot crashed with `Unable to locate the opencode CLI on PATH` and s6 restarted the add-on forever: nothing image-less can satisfy that lookup. The Dockerfile now installs the same certified `opencode-ai` 1.18.31 pin as the OpenCode add-on (build-time version assertion, non-matching platform binaries trimmed, `opencode --version` asserted), so the binary upstream wants is genuinely on PATH. It is still never spawned: all API calls keep proxying to the OpenCode add-on's LAN server.

## 1.1.0

- **Trusted-remote allowlist replaces basic auth on the LAN port** — the mapped `4097/tcp` no longer prompts for credentials. The proxy now only accepts loopback plus the addresses in the new **LAN trusted remotes** option (IPs or CIDRs, e.g. your nginx/OAuth proxy's source); every other request — WebSocket upgrades included — is redirected to the new **LAN redirect URL** (e.g. `https://openchamber.pl4.dev`, where the OAuth proxy authenticates properly) or refused with 403 when unset. Each rejection is logged with the source address, so an unknown proxy IP is discovered from the add-on log and then added to the list; an empty list means loopback-only. The env-gated basic-auth code stays in the proxy for opt-in use. Ingress (Home Assistant login) and the OpenCode server credentials are unchanged.

## 1.0.1

- **Mirrors the OpenCode add-on's directory mounts** — 1.0.0 shipped with no `map` entries, so the container only had its own `/data`: `/homeassistant`, `/local_apps`, `/addon_configs` and `/share` were missing, breaking anything that expected workspace paths to exist locally. All four now mount read-write exactly as in ha_opencode, the server runs with `/homeassistant` as its working directory (matching pre-split behaviour), and the image `WORKDIR` follows. Still no Supervisor or Home Assistant API access — mounts are filesystem-level only.

## 1.0.0

- **First release — OpenChamber as its own add-on** — the OpenChamber browser UI for OpenCode conversations, split out of the OpenCode add-on (ha_opencode 2.14.0 removes its bundled copy). Runs the pinned `@openchamber/web` 1.24.1 in a dedicated slim image (base-debian + Node 24.21.0, Ingress-patched bundle, first-party ingress proxy) with no OpenCode runtime, terminal, or MCP server of its own. Directory mounts mirror the OpenCode add-on (`/homeassistant`, `/local_apps`, `/addon_configs`, `/share`) so workspace paths behave identically; there is still no Supervisor or Home Assistant API access.
- **Attaches to the OpenCode add-on's LAN server instead of spawning OpenCode** — upstream's external-server mode (`OPENCODE_HOST` + `OPENCODE_SKIP_START`): the add-on auto-discovers the Docker host gateway (explicit `opencode_host` override supported), waits up to two minutes for the server, and authenticates every API call with the shared basic-auth credentials. Sessions shown are exactly the OpenCode add-on's; OpenChamber keeps none of its own.
- **Basic authentication on the LAN web UI** — the mappable 4097/tcp proxy instance now requires HTTP Basic auth (constant-time comparison, 401 + `WWW-Authenticate` on plain requests and WebSocket upgrades alike) using the same `opencode_username`/`opencode_password` options. The Home Assistant Ingress listener keeps its strict remote allowlist and stays authentication-free — Home Assistant's login covers it. This is the pattern the OpenCode add-on's LAN server adopts in the same release, so one credential pair protects both exposed ports.

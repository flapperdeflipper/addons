# Terminal

A personal bash + vim environment inside Home Assistant, with Claude Code and
OpenCode's terminal interface on hand. Your dotfiles and toolset repositories
are cloned into the container and stowed into the persistent home directory,
so the shell behaves like any other machine you work on.

## How it works

- The terminal is served through Home Assistant Ingress (sidebar icon), backed
  by ttyd + tmux. Disconnecting and reconnecting reattaches to the same
  session. There is no SSH server and no exposed port.
- `/data` is the home directory and persists across restarts. Sessions start
  in `/homeassistant`, which is mounted read-write so you can edit the Home
  Assistant configuration with vim.
- At every start (option `sync_dotfiles`):
  1. The toolset repository is cloned or pulled into `/data/.toolset`
  2. The dotfiles repository is cloned or pulled into `/data/.dotfiles`
  3. `~/.custom_aliases` is created from the dotfiles template if absent
  4. The dotfiles profile is stowed into `/data` (`update-profile --apply`)
  5. Python dependencies are installed into `/data/.venv` (background)
- The image carries node, npm, gh, jq, yq, ripgrep, rsync, tmux, cosign, hab,
  zigporter, Claude Code and the OpenCode client. Every tool is a fixed
  version; nothing updates itself inside the container (a new version comes
  with an add-on update).

## First start: private repository access

The dotfiles repository is private. Pick one:

1. **Interactive (once):** open the Terminal, run `gh auth login`, follow the
   device flow, then run `dotfiles-sync`. The login is stored under
   `/data/.config/gh` and survives restarts.
2. **Token:** add a GitHub token as an env var in the add-on Configuration
   tab (`env_vars`: name `GH_TOKEN`, value `<token>`) and restart.

After the first successful clone, the dotfiles' own SSH configuration and
keys are stowed into `~/.ssh`, so plain `git pull` over SSH works too.

## Commands

- `dotfiles-sync` — clone/pull both repositories, re-stow, reinstall python
  dependencies (`--no-python` to skip)
- `claude` — Claude Code. Log in once by running it (a browser flow); the
  login is stored under `/data` (`~/.claude`, `~/.claude.json`), so it
  survives restarts and is part of the add-on's backups.
- `opencode-hd [directory]` — OpenCode's terminal interface, attached to the
  OpenCode server on another host. Needs `OPENCODE_SERVER_URL` and
  `OPENCODE_PASSWORD` in `env_vars` (the password as `!secret <key>`);
  `OPENCODE_DIRECTORY` (default `/workspace`) is the project directory on the
  server. Nothing starts it automatically.
- `hab`, `zigporter`, `yq`, `gh` — Home Assistant and general tooling. hab's
  ESPHome commands need `HA_ACCESS_TOKEN`, zigporter's Z2M commands `Z2M_URL`
  (both in `env_vars`).

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `terminal_theme` | `breeze` | Color scheme |
| `font_size` | `14` | Font size in pixels |
| `cursor_style` | `block` | Cursor shape |
| `cursor_blink` | `false` | Blink the cursor |
| `sync_dotfiles` | `true` | Clone/pull and stow at every start |
| `dotfiles_repo` | `git@github.com:flapperdeflipper/dotfiles.git` | Dotfiles repository URL |
| `toolset_repo` | `https://github.com/flapperdeflipper/toolset.git` | Toolset repository URL |
| `install_python_deps` | `true` | Maintain the `/data/.venv` from the dotfiles pyproject |
| `env_vars` | `[]` | Environment variables for every session (e.g. `GH_TOKEN`, `OPENCODE_SERVER_URL`); a value can be `!secret <key>` |

## Notes

- Local changes in `/data/.dotfiles` or `/data/.toolset` are never overwritten:
  pulls are skipped when a checkout is dirty.
- The virtualenv is excluded from backups; it is rebuilt from the dotfiles
  `pyproject.toml` when absent.

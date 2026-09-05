# Terminal

A personal bash + vim environment inside Home Assistant, built on top of the
OpenCode add-on image. Your dotfiles and toolset repositories are cloned into
the container and stowed into the persistent home directory, so the shell
behaves like any other machine you work on.

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
- Everything the OpenCode image ships is available: node, npm, gh, glab, jq,
  yq, rsync, chromium, hab, zigporter, the 1Password CLI and the `opencode`
  runtime itself.

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
- `opencode` — the AI coding agent from the base image
- `hab`, `zigporter`, `yq`, `gh`, `glab` — toolchain from the base image

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `terminal_theme` | `breeze` | Color scheme (same set as the OpenCode terminal) |
| `font_size` | `14` | Font size in pixels |
| `cursor_style` | `block` | Cursor shape |
| `cursor_blink` | `false` | Blink the cursor |
| `sync_dotfiles` | `true` | Clone/pull and stow at every start |
| `dotfiles_repo` | `git@github.com:flapperdeflipper/dotfiles.git` | Dotfiles repository URL |
| `toolset_repo` | `https://github.com/flapperdeflipper/toolset.git` | Toolset repository URL |
| `install_python_deps` | `true` | Maintain the `/data/.venv` from the dotfiles pyproject |
| `env_vars` | `[]` | Environment variables for every session (e.g. `GH_TOKEN`) |

## Notes

- Local changes in `/data/.dotfiles` or `/data/.toolset` are never overwritten:
  pulls are skipped when a checkout is dirty.
- The virtualenv is excluded from backups; it is rebuilt from the dotfiles
  `pyproject.toml` when absent.
